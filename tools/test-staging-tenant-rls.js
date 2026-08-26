#!/usr/bin/env node
'use strict';

// Destructive-canary test for MAGNET OS STAGING only. It creates synthetic
// identities/records, proves tenant and role isolation through real JWTs, and
// removes every canary. No token, key, password, email, or row payload is printed.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';

function parseArgs(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const position = raw.indexOf('=');
    result[raw.slice(2, position < 0 ? undefined : position)] = position < 0 ? true : raw.slice(position + 1);
  }
  return result;
}

function safeText(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[REDACTED_EMAIL]')
    .slice(-3000);
}

function commandJson(args) {
  const command = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (command.status !== 0) throw new Error(safeText(command.stderr || command.stdout));
  const output = String(command.stdout || '');
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const projectRef = String(parseArgs(process.argv)['project-ref'] || '').trim();
  if (!/^[a-z]{20}$/.test(projectRef) || projectRef === PRODUCTION_REF) {
    throw new Error('Refused: explicit non-Production project ref required.');
  }
  const project = commandJson(['projects', 'list', '--output', 'json']).find((item) => item.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not healthy MAGNET OS STAGING.');
  }
  const keys = commandJson(['projects', 'api-keys', '--project-ref', projectRef, '--output', 'json']);
  const publishable = keys.find((item) => item.type === 'publishable') || keys.find((item) => item.name === 'anon');
  const service = keys.find((item) => item.name === 'service_role') || keys.find((item) => item.type === 'secret');
  if (!publishable || !service) throw new Error('Required Staging key classes unavailable.');

  const base = `https://${projectRef}.supabase.co`;
  const serviceHeaders = { apikey: service.api_key, Authorization: `Bearer ${service.api_key}`, 'Content-Type': 'application/json' };
  const anonHeaders = { apikey: publishable.api_key, 'Content-Type': 'application/json' };
  const suffix = crypto.randomBytes(10).toString('hex');
  const roleKeys = ['sales', 'content_creator', 'hr', 'finance'];
  const identities = [];
  const recordIds = [];
  const cleanupFailures = [];
  let secondOrganizationId = null;
  const assertions = [];
  const check = (condition, label) => {
    assertions.push({ pass: !!condition, label });
    if (!condition) throw new Error(`Assertion failed: ${label}`);
  };

  async function serviceRows(path, init = {}) {
    const result = await jsonFetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers || {}) } });
    if (!result.response.ok) throw new Error(`Staging service request failed (${result.response.status})`);
    return result.body;
  }

  async function createIdentity(roleKey, roleId, organizationId) {
    const email = `tenant-${roleKey}-${suffix}@example.invalid`;
    const password = `TenantAa1-${crypto.randomBytes(18).toString('base64url')}`;
    const created = await jsonFetch(`${base}/auth/v1/admin/users`, {
      method: 'POST', headers: serviceHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `Tenant ${roleKey} Canary` } }),
    });
    check(created.response.status === 200 && created.body.id, `disposable ${roleKey} identity created`);
    const identity = { id: created.body.id, email, password, roleKey };
    identities.push(identity);
    await serviceRows(`profiles?id=eq.${identity.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ identity_status: 'ACTIVE', onboarding_status: 'COMPLETED' }),
    });
    await serviceRows('organization_members', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ organization_id: organizationId, user_id: identity.id, role_id: roleId, status: 'ACTIVE', joined_at: new Date().toISOString() }),
    });
    const session = await jsonFetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: anonHeaders, body: JSON.stringify({ email, password }),
    });
    check(session.response.status === 200 && session.body.access_token, `${roleKey} JWT issued`);
    identity.token = session.body.access_token;
    return identity;
  }

  function userHeaders(identity, extra) {
    return Object.assign({ apikey: publishable.api_key, Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, extra || {});
  }

  async function userRequest(identity, path, init = {}) {
    return jsonFetch(`${base}/rest/v1/${path}`, { ...init, headers: userHeaders(identity, init.headers) });
  }

  try {
    const organizations = await serviceRows('organizations?slug=eq.magnet&status=eq.ACTIVE&select=id&limit=1');
    check(Array.isArray(organizations) && organizations[0], 'Magnet organization exists');
    const organizationId = organizations[0].id;
    const roles = await serviceRows(`organization_roles?organization_id=eq.${organizationId}&key=in.(${roleKeys.join(',')})&select=id,key`);
    const roleByKey = new Map(roles.map((role) => [role.key, role.id]));
    check(roleKeys.every((key) => roleByKey.has(key)), 'canonical role matrix exists');

    const users = {};
    for (const roleKey of roleKeys) users[roleKey] = await createIdentity(roleKey, roleByKey.get(roleKey), organizationId);

    const secondOrganization = await serviceRows('organizations', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name: 'Tenant Isolation Canary', slug: `tenant-canary-${suffix}`, status: 'ACTIVE', timezone: 'Africa/Cairo', locale: 'en' }),
    });
    secondOrganizationId = secondOrganization[0].id;

    // These collections exercise the same capability families without firing
    // append-only V2 projection/event tables. That makes every canary safely
    // removable after the browser/JWT assertions finish.
    const canaries = [
      { id: `rls-crm-${suffix}`, coll: 'proposals', organization_id: organizationId, data: { id: `rls-crm-${suffix}`, name: 'Synthetic CRM Canary', createdBy: users.sales.id } },
      { id: `rls-work-${suffix}`, coll: 'deliverables', organization_id: organizationId, data: { id: `rls-work-${suffix}`, title: 'Synthetic Work Canary', createdBy: users.content_creator.id, assignedTo: users.content_creator.id } },
      { id: `rls-hr-${suffix}`, coll: 'freelancers', organization_id: organizationId, data: { id: `rls-hr-${suffix}`, fullName: 'Synthetic HR Canary', createdBy: users.hr.id } },
      { id: `rls-fin-${suffix}`, coll: 'expenses', organization_id: organizationId, data: { id: `rls-fin-${suffix}`, amount: 1, createdBy: users.finance.id } },
      { id: `rls-cross-${suffix}`, coll: 'proposals', organization_id: secondOrganizationId, data: { id: `rls-cross-${suffix}`, name: 'Cross Tenant Canary' } },
    ];
    recordIds.push(...canaries.map((row) => row.id));
    await serviceRows('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(canaries) });

    const anonRead = await jsonFetch(`${base}/rest/v1/records?select=id&limit=1`, { headers: anonHeaders });
    check(
      [401, 403].includes(anonRead.response.status)
        || (anonRead.response.status === 200 && Array.isArray(anonRead.body) && anonRead.body.length === 0),
      'anonymous business read denied or returns zero rows',
    );
    const anonWrite = await jsonFetch(`${base}/rest/v1/records`, {
      method: 'POST', headers: anonHeaders,
      body: JSON.stringify({ id: `rls-anon-${suffix}`, coll: 'leads', organization_id: organizationId, data: { id: `rls-anon-${suffix}` } }),
    });
    check([401, 403].includes(anonWrite.response.status), 'anonymous business write rejected');
    const backupRead = await jsonFetch(`${base}/rest/v1/records_backup_001?select=id&limit=1`, { headers: anonHeaders });
    check([401, 403].includes(backupRead.response.status), 'anonymous legacy backup access rejected');

    const salesCrm = await userRequest(users.sales, `records?id=eq.rls-crm-${suffix}&select=id`);
    check(salesCrm.response.status === 200 && salesCrm.body.length === 1, 'Sales can read CRM');
    const contentCrm = await userRequest(users.content_creator, `records?id=eq.rls-crm-${suffix}&select=id`);
    check(contentCrm.response.status === 200 && contentCrm.body.length === 0, 'Content cannot read CRM');
    const contentWork = await userRequest(users.content_creator, `records?id=eq.rls-work-${suffix}&select=id`);
    check(contentWork.response.status === 200 && contentWork.body.length === 1, 'Content can read work');
    const contentHr = await userRequest(users.content_creator, `records?id=eq.rls-hr-${suffix}&select=id`);
    check(contentHr.response.status === 200 && contentHr.body.length === 0, 'Content cannot read HR');
    const hrRecord = await userRequest(users.hr, `records?id=eq.rls-hr-${suffix}&select=id`);
    check(hrRecord.response.status === 200 && hrRecord.body.length === 1, 'HR can read HR');
    const contentFinance = await userRequest(users.content_creator, `records?id=eq.rls-fin-${suffix}&select=id`);
    check(contentFinance.response.status === 200 && contentFinance.body.length === 0, 'Content cannot read Finance');
    const financeRecord = await userRequest(users.finance, `records?id=eq.rls-fin-${suffix}&select=id`);
    check(financeRecord.response.status === 200 && financeRecord.body.length === 1, 'Finance can read Finance');
    const crossTenant = await userRequest(users.sales, `records?id=eq.rls-cross-${suffix}&select=id`);
    check(crossTenant.response.status === 200 && crossTenant.body.length === 0, 'cross-tenant record is invisible');

    const missingTenant = await userRequest(users.sales, 'records', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id: `rls-missing-org-${suffix}`, coll: 'leads', data: { id: `rls-missing-org-${suffix}`, createdBy: users.sales.id } }),
    });
    check(missingTenant.response.status >= 400, 'write without organization_id rejected');
    const unauthorizedHrWrite = await userRequest(users.sales, 'records', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id: `rls-denied-${suffix}`, coll: 'candidates', organization_id: organizationId, data: { id: `rls-denied-${suffix}`, createdBy: users.sales.id } }),
    });
    check([401, 403].includes(unauthorizedHrWrite.response.status), 'Sales HR write rejected');

    const salesWriteId = `rls-sales-write-${suffix}`;
    recordIds.push(salesWriteId);
    const salesWrite = await userRequest(users.sales, 'records', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id: salesWriteId, coll: 'proposals', organization_id: organizationId, data: { id: salesWriteId, name: 'Authorized', createdBy: users.sales.id } }),
    });
    check(salesWrite.response.status === 201, 'Sales CRM write accepted');
    const hardDelete = await userRequest(users.sales, `records?id=eq.${salesWriteId}`, { method: 'DELETE' });
    check([401, 403].includes(hardDelete.response.status), 'authenticated hard delete rejected');

    const tenantMaps = await serviceRows(`legacy_record_tenant_map?record_id=eq.${salesWriteId}&select=record_id,organization_id,migration_status`);
    check(tenantMaps.length === 1 && tenantMaps[0].organization_id === organizationId && tenantMaps[0].migration_status === 'VALIDATED', 'tenant map synchronized for new record');

    const softDelete = await userRequest(users.sales, 'rpc/soft_delete_record', {
      method: 'POST',
      body: JSON.stringify({ p_organization_id: organizationId, p_record_id: salesWriteId }),
    });
    if (!(softDelete.response.status === 200 && softDelete.body === true)) {
      throw new Error(`Soft-delete RPC failed (${softDelete.response.status}): ${safeText(JSON.stringify({ code: softDelete.body && softDelete.body.code, message: softDelete.body && softDelete.body.message }))}`);
    }
    check(softDelete.response.status === 200 && softDelete.body === true, 'authorized soft delete accepted');
    const deletedBrowserRead = await userRequest(users.sales, `records?id=eq.${salesWriteId}&select=id`);
    check(deletedBrowserRead.response.status === 200 && deletedBrowserRead.body.length === 0, 'soft-deleted record is hidden from browser reads');
    const deletedServiceRead = await serviceRows(`records?id=eq.${salesWriteId}&select=id,deleted_at,data`);
    check(deletedServiceRead.length === 1 && deletedServiceRead[0].deleted_at && deletedServiceRead[0].data._del === true, 'soft-delete tombstone remains recoverable server-side');
  } finally {
    for (const recordId of recordIds) {
      const mapDelete = await fetch(
        `${base}/rest/v1/legacy_record_tenant_map?record_id=eq.${encodeURIComponent(recordId)}`,
        { method: 'DELETE', headers: serviceHeaders },
      ).catch(() => null);
      if (!mapDelete || !mapDelete.ok) cleanupFailures.push('tenant-map');
      const recordDelete = await fetch(
        `${base}/rest/v1/records?id=eq.${encodeURIComponent(recordId)}`,
        { method: 'DELETE', headers: serviceHeaders },
      ).catch(() => null);
      if (!recordDelete || !recordDelete.ok) cleanupFailures.push('record');
    }
    if (secondOrganizationId) {
      const organizationDelete = await fetch(`${base}/rest/v1/organizations?id=eq.${secondOrganizationId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
      if (!organizationDelete || !organizationDelete.ok) cleanupFailures.push('organization');
    }
    for (const identity of identities.reverse()) {
      await fetch(`${base}/auth/v1/admin/users/${identity.id}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
  }

  const remaining = await jsonFetch(`${base}/rest/v1/records?id=like.rls-*-${suffix}&select=id`, { headers: serviceHeaders });
  check(remaining.response.ok && Array.isArray(remaining.body) && remaining.body.length === 0, 'all RLS canary records removed');
  check(cleanupFailures.length === 0, 'all RLS canary cleanup operations succeeded');
  const failed = assertions.filter((assertion) => !assertion.pass);
  process.stdout.write(`Tenant RLS E2E: ${assertions.length - failed.length} passed, ${failed.length} failed. Synthetic users and records removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Tenant RLS E2E failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
