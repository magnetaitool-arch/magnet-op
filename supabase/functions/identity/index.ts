// MAGNET OS V2 canonical identity service.
// Supabase Auth JWT + live profile + organization membership + capabilities are
// resolved on every request. The legacy account token is never accepted here.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLISHABLE_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const REST_URL = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1';
const AUTH_URL = SUPABASE_URL.replace(/\/$/, '') + '/auth/v1';

const configuredOrigins = String(Deno.env.get('ALLOWED_ORIGINS') || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set(configuredOrigins.length ? configuredOrigins : [
  'https://magnet-os-staging.vercel.app',
  'http://127.0.0.1:4175',
  'http://localhost:4175',
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-request-id',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function reply(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function validUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function accessToken(request: Request) {
  const authorization = String(request.headers.get('authorization') || '');
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

async function authenticatedUser(jwt: string) {
  if (!jwt) return null;
  const response = await fetch(AUTH_URL + '/user', {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user && validUuid(user.id) ? user : null;
}

async function serviceRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(REST_URL + '/' + path, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const knownCategory = ['identity_last_owner','identity_forbidden','identity_membership_not_found','identity_role_not_found']
      .find((category) => errorBody.includes(category));
    throw new Error(knownCategory || `database_${response.status}`);
  }
  if (response.status === 204) return null;
  return await response.json().catch(() => null);
}

async function userContext(jwt: string) {
  const response = await fetch(REST_URL + '/rpc/current_identity_context', {
    method: 'POST',
    headers: {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!response.ok) throw new Error(`context_${response.status}`);
  return await response.json().catch(() => null);
}

function membershipFor(context: any, organizationId: string) {
  const memberships = Array.isArray(context && context.memberships) ? context.memberships : [];
  return memberships.find((membership: any) => membership.organizationId === organizationId) || null;
}

function hasCapability(context: any, organizationId: string, capability: string) {
  const membership = membershipFor(context, organizationId);
  return !!(membership && membership.membershipStatus === 'ACTIVE' &&
    membership.organizationStatus === 'ACTIVE' &&
    Array.isArray(membership.capabilities) && membership.capabilities.includes(capability));
}

async function listMembers(organizationId: string) {
  const memberships = await serviceRequest(
    `organization_members?organization_id=eq.${encodeURIComponent(organizationId)}&select=id,user_id,role_id,status,joined_at,updated_at&order=created_at.asc`,
  ) || [];
  const roles = await serviceRequest(
    `organization_roles?organization_id=eq.${encodeURIComponent(organizationId)}&select=id,key,name&order=name.asc`,
  ) || [];
  const userIds = memberships.map((membership: any) => membership.user_id).filter(validUuid);
  const profiles = userIds.length ? await serviceRequest(
    `profiles?id=in.(${userIds.join(',')})&select=id,display_name,email_normalized,identity_status,onboarding_status,session_epoch`,
  ) || [] : [];
  const links = userIds.length ? await serviceRequest(
    `legacy_identity_links?auth_user_id=in.(${userIds.join(',')})&link_status=eq.CONFIRMED&select=legacy_account_row_id,auth_user_id,employee_record_id`,
  ) || [] : [];
  const roleById = new Map(roles.map((role: any) => [role.id, role]));
  const profileById = new Map(profiles.map((profile: any) => [profile.id, profile]));
  const linkByUserId = new Map(links.map((link: any) => [link.auth_user_id, link]));
  return memberships.map((membership: any) => {
    const profile: any = profileById.get(membership.user_id) || {};
    const role: any = roleById.get(membership.role_id) || {};
    const legacyLink: any = linkByUserId.get(membership.user_id) || {};
    const legacyRecordId = String(legacyLink.legacy_account_row_id || '');
    return {
      membershipId: membership.id,
      organizationId,
      userId: membership.user_id,
      displayName: profile.display_name || '',
      email: profile.email_normalized || '',
      identityStatus: profile.identity_status || 'PENDING_SETUP',
      onboardingStatus: profile.onboarding_status || 'PENDING',
      sessionEpoch: Number(profile.session_epoch || 0),
      membershipStatus: membership.status,
      roleId: membership.role_id,
      roleKey: role.key || '',
      roleName: role.name || '',
      legacyAccountRecordId: legacyRecordId,
      legacyUserId: legacyRecordId.startsWith('acct-') ? legacyRecordId.slice(5) : legacyRecordId,
      employeeRecordId: legacyLink.employee_record_id || '',
      joinedAt: membership.joined_at || null,
      updatedAt: membership.updated_at || null,
    };
  });
}

Deno.serve(async (request) => {
  const requestId = validUuid(request.headers.get('x-request-id'))
    ? String(request.headers.get('x-request-id')) : crypto.randomUUID();
  const origin = request.headers.get('origin') || '';
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply(request, { ok: false, error: 'origin_not_allowed', requestId }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return reply(request, { ok: false, error: 'method_not_allowed', requestId }, 405);

  let body: any;
  try { body = await request.json(); } catch { return reply(request, { ok: false, error: 'invalid_json', requestId }, 400); }
  const action = String(body && body.action || '');
  if (action === 'health') return reply(request, { ok: true, service: 'identity', version: 1, auth: 'supabase', requestId });

  const jwt = accessToken(request);
  const user = await authenticatedUser(jwt);
  if (!user) return reply(request, { ok: false, error: 'unauthorized', requestId }, 401);

  try {
    const context = await userContext(jwt);
    if (!context) return reply(request, { ok: false, error: 'profile_missing', requestId }, 403);
    if (context.status !== 'ACTIVE') return reply(request, { ok: false, error: 'identity_inactive', requestId }, 403);

    if (action === 'context') {
      const activeMemberships = (context.memberships || []).filter((membership: any) =>
        membership.membershipStatus === 'ACTIVE' && membership.organizationStatus === 'ACTIVE');
      if (!activeMemberships.length) return reply(request, { ok: false, error: 'membership_missing', context, requestId }, 403);
      return reply(request, { ok: true, context, requestId });
    }

    const organizationId = String(body.organizationId || '');
    if (!validUuid(organizationId) || !hasCapability(context, organizationId, 'members.manage')) {
      return reply(request, { ok: false, error: 'forbidden', requestId }, 403);
    }

    if (action === 'members') {
      return reply(request, { ok: true, members: await listMembers(organizationId), requestId });
    }

    if (action === 'update_membership') {
      const targetUserId = String(body.userId || '');
      const roleKey = String(body.roleKey || '').trim().toLowerCase();
      const status = String(body.status || 'ACTIVE').trim().toUpperCase();
      if (!validUuid(targetUserId) || !/^[a-z0-9_]+$/.test(roleKey) ||
          !['ACTIVE','SUSPENDED','DISABLED','ARCHIVED'].includes(status)) {
        return reply(request, { ok: false, error: 'invalid_input', requestId }, 400);
      }
      const result = await serviceRequest('rpc/identity_update_membership', {
        method: 'POST',
        body: JSON.stringify({
          p_actor_user_id: user.id,
          p_organization_id: organizationId,
          p_target_user_id: targetUserId,
          p_role_key: roleKey,
          p_status: status,
          p_request_id: requestId,
        }),
      });
      return reply(request, { ok: true, result, requestId });
    }

    return reply(request, { ok: false, error: 'unknown_action', requestId }, 400);
  } catch (error) {
    const category = String((error as Error)?.message || 'identity_error').slice(0, 120);
    console.error(JSON.stringify({ requestId, category }));
    if (category === 'identity_last_owner') return reply(request, { ok: false, error: 'last_owner', requestId }, 409);
    if (category === 'identity_forbidden') return reply(request, { ok: false, error: 'forbidden', requestId }, 403);
    if (category === 'identity_membership_not_found' || category === 'identity_role_not_found') {
      return reply(request, { ok: false, error: 'membership_not_found', requestId }, 404);
    }
    return reply(request, { ok: false, error: 'server_error', requestId }, 500);
  }
});
