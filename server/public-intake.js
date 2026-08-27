'use strict';

const crypto = require('node:crypto');

const CANDIDATE_FIELDS = ['fullName','age','mobile','otherPhones','email','area','maritalStatus','position','specialization','experience','availableFrom','currentSalary','expectedSalary','workplaces','courses','gameScore','cvLink','notes'];
const LEAD_FIELDS = ['name','company','email','phone','brand','source','serviceInterest','value','budget','notes','message','campaignId','campaignName'];
let organizationCache = null;

function normalOrigin(value) {
  try { return new URL(String(value || '')).origin; } catch (error) { return ''; }
}

function allowedOrigins(env) {
  const extra = String(env.MAGNET_FORM_ALLOWED_ORIGINS || env.PUBLIC_FORM_ALLOWED_ORIGINS || '')
    .split(',').map((item) => normalOrigin(item.trim())).filter(Boolean);
  const deployment = env.VERCEL_URL ? normalOrigin('https://' + env.VERCEL_URL) : '';
  return new Set(['https://magnet-op.vercel.app', 'https://magnet-os-staging.vercel.app', deployment, ...extra].filter(Boolean));
}

function responseHeaders(origin, env) {
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, x-magnet-intake-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  const normalized = normalOrigin(origin);
  if (normalized && allowedOrigins(env).has(normalized)) headers['Access-Control-Allow-Origin'] = normalized;
  return headers;
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value, encoding = 'base64url') {
  return crypto.createHash('sha256').update(String(value)).digest(encoding);
}

function clip(value, size) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, size);
}

function pick(body, fields) {
  const output = {};
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') continue;
    output[field] = clip(body[field], field === 'notes' || field === 'message' ? 5000 : 2000);
  }
  return output;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function validPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 16;
}

function sanitizePayload(body) {
  if (body.type === 'candidate') {
    const payload = pick(body, CANDIDATE_FIELDS);
    payload.email = clip(payload.email, 320).toLowerCase();
    if (!payload.fullName || !validPhone(payload.mobile) || !validEmail(payload.email)) throw new Error('invalid_candidate');
    if (payload.cvLink && !/^https?:\/\//i.test(payload.cvLink)) delete payload.cvLink;
    return payload;
  }
  if (body.type === 'lead') {
    const payload = pick(body, LEAD_FIELDS);
    if (payload.email) payload.email = clip(payload.email, 320).toLowerCase();
    if (!payload.name && !payload.company) throw new Error('invalid_lead');
    if (!validEmail(payload.email) && !validPhone(payload.phone)) throw new Error('invalid_lead');
    return payload;
  }
  throw new Error('invalid_type');
}

function serviceHeaders(key) {
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function organizationId(base, key, env) {
  if (organizationCache && organizationCache.base === base && organizationCache.slug === env.SUPABASE_ORGANIZATION_SLUG) return organizationCache.id;
  const slug = clip(env.SUPABASE_ORGANIZATION_SLUG || 'magnet', 80);
  const result = await jsonFetch(base + '/rest/v1/organizations?slug=eq.' + encodeURIComponent(slug) + '&status=eq.ACTIVE&deleted_at=is.null&select=id&limit=1', {
    headers: serviceHeaders(key),
  });
  const id = result.response.ok && Array.isArray(result.payload) && result.payload[0] && result.payload[0].id;
  if (!id) throw new Error('organization_unavailable');
  organizationCache = { base, slug: env.SUPABASE_ORGANIZATION_SLUG, id };
  return id;
}

async function attemptQueuedDeliveries(base, key, env, organizationIdValue, entityId) {
  if (!entityId) return 0;
  const emailReady = !!(env.RESEND_API_KEY && (env.HR_EMAIL || env.SALES_EMAIL));
  const whatsappReady = !!(env.WHATSAPP_PROVIDER === 'meta' && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && (env.HR_WHATSAPP || env.SALES_WHATSAPP));
  if (!emailReady && !whatsappReady) return 0;
  const query = new URLSearchParams({
    organization_id: 'eq.' + organizationIdValue,
    'payload->>entityId': 'eq.' + entityId,
    status: 'eq.PENDING',
    select: 'id',
    limit: '4',
  });
  const queued = await jsonFetch(base + '/rest/v1/outbox_messages?' + query.toString(), {
    headers: serviceHeaders(key),
  });
  if (!queued.response.ok || !Array.isArray(queued.payload) || !queued.payload.length) return 0;
  const { processOutbox } = require('./outbox');
  let attempted = 0;
  for (const message of queued.payload) {
    if (!message || !message.id) continue;
    const result = await processOutbox({ base, key }, env, { limit: 1, messageId: message.id });
    if (result.length) attempted += 1;
  }
  return attempted;
}

function requestFingerprint(headers, key) {
  const forwarded = clip(headers['x-vercel-forwarded-for'] || headers['x-forwarded-for'] || headers['client-ip'] || 'unknown', 256).split(',')[0];
  const agent = clip(headers['user-agent'] || 'unknown', 512);
  return crypto.createHmac('sha256', key).update(forwarded + '\n' + agent).digest('base64url');
}

function errorStatus(code) {
  if (code === 'rate_limited') return 429;
  if (code === 'idempotency_conflict' || code === 'request_in_progress') return 409;
  if (code === 'invalid_candidate' || code === 'invalid_lead' || code === 'invalid_type') return 400;
  return 503;
}

async function handlePublicIntake(request, env = process.env) {
  const method = String(request.method || '').toUpperCase();
  const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
  const origin = String(headers.origin || '');
  const cors = responseHeaders(origin, env);
  const trustedSecret = String(env.PUBLIC_INTAKE_SHARED_SECRET || '');
  const hasTrustedSecret = !!(trustedSecret && headers['x-magnet-intake-secret'] === trustedSecret);
  const originAllowed = !!(normalOrigin(origin) && allowedOrigins(env).has(normalOrigin(origin)));

  if (method === 'OPTIONS') return { status: originAllowed ? 200 : 403, headers: cors, body: originAllowed ? {} : { error: 'origin_not_allowed' } };
  if (method !== 'POST') return { status: 405, headers: cors, body: { error: 'method_not_allowed' } };
  if (!originAllowed && !hasTrustedSecret) return { status: 403, headers: cors, body: { error: 'origin_not_allowed' } };
  if (Number(headers['content-length'] || 0) > 150000) return { status: 413, headers: cors, body: { error: 'payload_too_large' } };

  let body = request.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (error) { return { status: 400, headers: cors, body: { error: 'invalid_json' } }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, headers: cors, body: { error: 'invalid_json' } };
  if (body.company_website || body.hp || body._gotcha) return { status: 200, headers: cors, body: { ok: true, skipped: true } };

  let payload;
  try { payload = sanitizePayload(body); }
  catch (error) { return { status: errorStatus(error.message), headers: cors, body: { error: error.message } }; }

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || '');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(base) || !key) return { status: 503, headers: cors, body: { error: 'service_not_configured' } };

  const canonical = stableStringify({ type: body.type, payload });
  const requestHash = digest(canonical);
  const rawIdempotency = clip(headers['idempotency-key'] || body.idempotencyKey || '', 200);
  const idempotencyKey = /^[A-Za-z0-9_./:-]{8,200}$/.test(rawIdempotency)
    ? rawIdempotency
    : 'auto:' + digest(canonical, 'hex');

  try {
    const orgId = await organizationId(base, key, env);
    const result = await jsonFetch(base + '/rest/v1/rpc/submit_public_intake', {
      method: 'POST',
      headers: serviceHeaders(key),
      body: JSON.stringify({
        p_organization_id: orgId,
        p_intake_kind: body.type,
        p_payload: payload,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash,
        p_fingerprint_hash: requestFingerprint(headers, env.PUBLIC_INTAKE_FINGERPRINT_SECRET || key),
      }),
    });
    if (!result.response.ok) {
      const code = clip(result.payload && result.payload.message, 100);
      return { status: errorStatus(code), headers: cors, body: { error: ['rate_limited','idempotency_conflict','request_in_progress'].includes(code) ? code : 'intake_failed' } };
    }
    let deliveryAttempted = 0;
    try {
      deliveryAttempted = await attemptQueuedDeliveries(base, key, env, orgId, result.payload && result.payload.id);
    } catch (error) {
      // The canonical intake is already committed. A pending outbox row remains
      // durable and can be retried by the worker without duplicating the intake.
    }
    return { status: 200, headers: cors, body: { ...result.payload, deliveryAttempted } };
  } catch (error) {
    console.error('[public-intake] request failed', {
      code: String(error && error.message) === 'organization_unavailable' ? 'organization_unavailable' : 'unexpected',
      environment: String(env.VERCEL_ENV || 'unknown'),
    });
    return { status: 503, headers: cors, body: { error: 'service_unavailable' } };
  }
}

module.exports = { handlePublicIntake, _test: { allowedOrigins, sanitizePayload, stableStringify, attemptQueuedDeliveries } };
