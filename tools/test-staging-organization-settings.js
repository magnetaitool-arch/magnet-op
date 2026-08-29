#!/usr/bin/env node
'use strict';

// Destructive-canary test for MAGNET OS STAGING only. It proves organization
// settings read/update isolation with real Supabase Auth JWTs, restores the
// original Staging settings, and removes all synthetic users/tenant rows.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
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
  if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
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
  const roleKeys = ['owner', 'hr', 'finance', 'content_creator', 'client'];
  const identities = [];
  const assertions = [];
  let organizationId = null;
  let secondOrganizationId = null;
  let originalSettings = null;
  const check = (condition, label) => {
    assertions.push({ pass: !!condition, label });
    if (!condition) throw new Error(`Assertion failed: ${label}`);
  };

  async function serviceRows(path, init = {}) {
    const result = await jsonFetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers || {}) } });
    if (!result.response.ok) throw new Error(`Staging service request failed (${result.response.status})`);
    return result.body;
  }

  async function createIdentity(roleKey, roleId) {
    const email = `settings-${roleKey}-${suffix}@example.invalid`;
    const password = `SettingsAa1-${crypto.randomBytes(18).toString('base64url')}`;
    const created = await jsonFetch(`${base}/auth/v1/admin/users`, {
      method: 'POST', headers: serviceHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `Settings ${roleKey} Canary` } }),
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
    return { apikey: publishable.api_key, Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json', ...(extra || {}) };
  }

  async function userRequest(identity, path, init = {}) {
    return jsonFetch(`${base}/rest/v1/${path}`, { ...init, headers: userHeaders(identity, init.headers) });
  }

  async function update(identity, patch, expectedVersion) {
    return userRequest(identity, 'rpc/update_organization_settings', {
      method: 'POST', body: JSON.stringify({ p_organization_id: organizationId, p_patch: patch, p_expected_version: expectedVersion }),
    });
  }

  try {
    const organizations = await serviceRows('organizations?slug=eq.magnet&status=eq.ACTIVE&select=id&limit=1');
    check(Array.isArray(organizations) && organizations[0], 'Magnet organization exists');
    organizationId = organizations[0].id;
    const roles = await serviceRows(`organization_roles?organization_id=eq.${organizationId}&key=in.(${roleKeys.join(',')})&select=id,key`);
    const roleByKey = new Map(roles.map((role) => [role.key, role.id]));
    check(roleKeys.every((key) => roleByKey.has(key)), 'settings role matrix exists');
    const users = {};
    for (const roleKey of roleKeys) users[roleKey] = await createIdentity(roleKey, roleByKey.get(roleKey));

    const initial = await serviceRows(`organization_settings?organization_id=eq.${organizationId}&select=*`);
    check(initial.length === 1, 'organization settings row exists');
    originalSettings = initial[0];

    const memberRead = await userRequest(users.content_creator, `organization_settings?organization_id=eq.${organizationId}&select=organization_id,settings,version`);
    check(memberRead.response.status === 200 && memberRead.body.length === 1, 'active member can read organization settings');
    const clientRead = await userRequest(users.client, `organization_settings?organization_id=eq.${organizationId}&select=organization_id,settings,version`);
    check(clientRead.response.status === 200 && clientRead.body.length === 0, 'client portal cannot read operational organization settings');

    const directWrite = await userRequest(users.owner, `organization_settings?organization_id=eq.${organizationId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ settings: {} }),
    });
    check([401, 403].includes(directWrite.response.status), 'direct browser settings update is rejected');

    const deniedContent = await update(users.content_creator, { emailNotifications: false }, originalSettings.version);
    check([401, 403].includes(deniedContent.response.status), 'Content cannot update organization settings');

    const hrUpdate = await update(users.hr, { workStartTime: '09:31' }, originalSettings.version);
    check(hrUpdate.response.status === 200 && hrUpdate.body.version === originalSettings.version + 1, 'HR can update attendance settings');

    const conflict = await update(users.hr, { workStartTime: '09:32' }, originalSettings.version);
    check(conflict.response.status >= 400, 'stale settings version is rejected');

    const deniedHrPayroll = await update(users.hr, { payroll: { testMode: true } }, hrUpdate.body.version);
    check([401, 403].includes(deniedHrPayroll.response.status), 'HR cannot update finance-only payroll settings');

    const financeUpdate = await update(users.finance, { payroll: { testMode: true } }, hrUpdate.body.version);
    check(financeUpdate.response.status === 200, 'Finance can update payroll settings');

    const ownerUpdate = await update(users.owner, { emailNotifications: originalSettings.settings.emailNotifications !== false }, financeUpdate.body.version);
    check(ownerUpdate.response.status === 200, 'Owner can update organization-wide settings');

    const unknown = await update(users.owner, { secretKey: 'blocked' }, ownerUpdate.body.version);
    check(unknown.response.status >= 400, 'unknown or secret-like setting keys are rejected');

    const audit = await serviceRows(`audit_events?organization_id=eq.${organizationId}&action=eq.organization.settings_updated&actor_user_id=in.(${users.hr.id},${users.finance.id},${users.owner.id})&select=id,safe_context`);
    check(audit.length >= 3 && audit.every((event) => event.safe_context && Array.isArray(event.safe_context.keys)), 'settings updates are audit logged without values');

    const secondOrganization = await serviceRows('organizations', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name: 'Settings Isolation Canary', slug: `settings-canary-${suffix}`, status: 'ACTIVE', timezone: 'Africa/Cairo', locale: 'en' }),
    });
    secondOrganizationId = secondOrganization[0].id;
    await serviceRows('organization_settings', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ organization_id: secondOrganizationId, settings: { currency: 'USD' } }),
    });
    const crossTenant = await userRequest(users.owner, `organization_settings?organization_id=eq.${secondOrganizationId}&select=organization_id`);
    check(crossTenant.response.status === 200 && crossTenant.body.length === 0, 'cross-tenant settings are invisible');
  } finally {
    if (originalSettings && organizationId) {
      await fetch(`${base}/rest/v1/organization_settings?organization_id=eq.${organizationId}`, {
        method: 'PATCH', headers: { ...serviceHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ settings: originalSettings.settings, version: originalSettings.version, updated_by: originalSettings.updated_by }),
      }).catch(() => null);
    }
    if (secondOrganizationId) {
      await fetch(`${base}/rest/v1/organization_settings?organization_id=eq.${secondOrganizationId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
      await fetch(`${base}/rest/v1/organizations?id=eq.${secondOrganizationId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
    for (const identity of identities.reverse()) {
      await fetch(`${base}/auth/v1/admin/users/${identity.id}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
  }

  const failed = assertions.filter((assertion) => !assertion.pass);
  process.stdout.write(`Organization settings E2E: ${assertions.length - failed.length} passed, ${failed.length} failed. Original Staging settings restored; synthetic users and tenant removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Organization settings E2E failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
