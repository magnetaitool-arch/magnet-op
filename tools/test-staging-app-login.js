#!/usr/bin/env node
'use strict';

// Staging-only full login cutover test. It creates one disposable legacy account,
// upgrades it to Supabase Auth, attaches a canonical Sales membership, deliberately
// leaves a conflicting legacy Content role, and proves that the live identity
// context still resolves Sales. Credentials and tokens are never printed.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
const ALLOWED_ORIGIN = 'https://magnet-os-staging.vercel.app';

function parseArgs(argv) {
  const output = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const separator = raw.indexOf('=');
    output[raw.slice(2, separator < 0 ? undefined : separator)] = separator < 0 ? true : raw.slice(separator + 1);
  }
  return output;
}

function safeText(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
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

function legacyPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256');
  return `pbkdf2$150000$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const projectRef = String(parseArgs(process.argv)['project-ref'] || '').trim();
  if (!/^[a-z]{20}$/.test(projectRef) || projectRef === PRODUCTION_REF) {
    throw new Error('Refused: an explicit non-Production project ref is required.');
  }
  const projects = commandJson(['projects', 'list', '--output', 'json']);
  const project = projects.find((candidate) => candidate.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not the healthy MAGNET OS STAGING project.');
  }
  const keys = commandJson(['projects', 'api-keys', '--project-ref', projectRef, '--output', 'json']);
  const publishable = keys.find((candidate) => candidate.type === 'publishable') || keys.find((candidate) => candidate.name === 'anon');
  const service = keys.find((candidate) => candidate.name === 'service_role') || keys.find((candidate) => candidate.type === 'secret');
  if (!publishable || !service) throw new Error('Required Staging API keys are unavailable.');

  const base = `https://${projectRef}.supabase.co`;
  const serviceHeaders = { apikey: service.api_key, Authorization: `Bearer ${service.api_key}`, 'Content-Type': 'application/json' };
  const suffix = crypto.randomBytes(10).toString('hex');
  const accountId = `v2-login-canary-${suffix}`;
  const recordId = `acct-${accountId}`;
  const email = `v2-login-${suffix}@example.invalid`;
  const username = `v2.login.${suffix}`;
  const password = `LoginAa1-${crypto.randomBytes(18).toString('base64url')}`;
  let authUserId = '';
  let createdRecord = false;
  const checks = [];
  const check = (condition, label) => {
    checks.push({ pass: !!condition, label });
    if (!condition) throw new Error(`Assertion failed: ${label}`);
  };

  async function serviceRows(path, init = {}) {
    const result = await jsonFetch(`${base}/rest/v1/${path}`, {
      ...init, headers: { ...serviceHeaders, ...(init.headers || {}) },
    });
    if (!result.response.ok) {
      const category = String(result.body && (result.body.code || result.body.message) || 'unknown');
      throw new Error(`Staging service request failed (${result.response.status}, ${category})`);
    }
    return result.body;
  }

  async function accountAction(action, payload = {}) {
    return await jsonFetch(`${base}/functions/v1/accounts`, {
      method: 'POST',
      headers: { apikey: publishable.api_key, Authorization: `Bearer ${publishable.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
  }

  async function identityAction(action, token, payload = {}) {
    return await jsonFetch(`${base}/functions/v1/identity`, {
      method: 'POST',
      headers: { apikey: publishable.api_key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ action, ...payload }),
    });
  }

  try {
    const organizations = await serviceRows('organizations?slug=eq.magnet&select=id&limit=1');
    const organizationId = organizations[0] && organizations[0].id;
    check(organizationId, 'Magnet organization exists');
    const account = {
      id: accountId,
      name: 'V2 Login Canary',
      fullName: 'V2 Login Canary',
      username,
      email,
      role: 'Content Creator',
      status: 'Active',
      verified: true,
      isDefaultPassword: false,
      access: {},
      passwordHash: legacyPasswordHash(password),
    };
    await serviceRows('records', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id: recordId, coll: '_accounts', data: account, organization_id: organizationId }),
    });
    createdRecord = true;

    const legacyLogin = await accountAction('login', { identifier: username, password });
    check(legacyLogin.response.status === 200 && legacyLogin.body.ok === true, 'legacy credentials validate');
    check(legacyLogin.body.user && legacyLogin.body.user.role === 'Content Creator', 'legacy snapshot contains deliberate stale Content role');

    const upgrade = await accountAction('authv2', { identifier: username, password });
    const accessToken = upgrade.body && upgrade.body.session && upgrade.body.session.access_token;
    check(upgrade.response.status === 200 && accessToken, 'legacy login upgrades to a Supabase session');

    const authUser = await jsonFetch(`${base}/auth/v1/user`, {
      headers: { apikey: publishable.api_key, Authorization: `Bearer ${accessToken}` },
    });
    authUserId = String(authUser.body && authUser.body.id || '');
    check(authUser.response.status === 200 && /^[0-9a-f-]{36}$/i.test(authUserId), 'Supabase JWT resolves an immutable user id');

    const roles = await serviceRows(`organization_roles?organization_id=eq.${organizationId}&key=in.(owner,sales,content_creator)&select=id,key`);
    const roleByKey = new Map(roles.map((role) => [role.key, role.id]));
    check(organizationId && roleByKey.has('owner') && roleByKey.has('sales') && roleByKey.has('content_creator'), 'Magnet canonical test roles exist');

    const canonical = await identityAction('context', accessToken);
    const membership = canonical.body && canonical.body.context && canonical.body.context.memberships && canonical.body.context.memberships[0];
    check(canonical.response.status === 200 && canonical.body.ok === true, 'first login automatically creates a usable canonical context');
    check(membership && membership.roleKey === 'content_creator', 'first login maps the verified legacy role exactly once');
    check(canonical.body.context.userId === authUserId, 'canonical identity is linked to the JWT subject');
    const links = await serviceRows(`legacy_identity_links?legacy_account_row_id=eq.${encodeURIComponent(recordId)}&auth_user_id=eq.${authUserId}&link_status=eq.CONFIRMED&select=legacy_account_row_id`);
    check(Array.isArray(links) && links.length === 1, 'first login creates one confirmed immutable identity link');

    await serviceRows(`records?id=eq.${encodeURIComponent(recordId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ data: { ...account, role: 'Sales', access: { leads: 'hidden' } } }),
    });
    const stillCanonical = await identityAction('context', accessToken);
    const stillMembership = stillCanonical.body && stillCanonical.body.context && stillCanonical.body.context.memberships && stillCanonical.body.context.memberships[0];
    check(stillMembership && stillMembership.roleKey === 'content_creator', 'a stale legacy role write cannot change canonical authorization');

    const activeOwners = await serviceRows(`organization_members?organization_id=eq.${organizationId}&role_id=eq.${roleByKey.get('owner')}&status=eq.ACTIVE&select=user_id&limit=1`);
    check(activeOwners[0] && activeOwners[0].user_id, 'an active owner exists for the administration command');
    await serviceRows('rpc/identity_update_membership', {
      method: 'POST',
      body: JSON.stringify({
        p_actor_user_id: activeOwners[0].user_id,
        p_organization_id: organizationId,
        p_target_user_id: authUserId,
        p_role_key: 'sales',
        p_status: 'ACTIVE',
        p_request_id: crypto.randomUUID(),
      }),
    });
    const synchronized = await serviceRows(`records?id=eq.${encodeURIComponent(recordId)}&select=data`);
    check(synchronized[0] && synchronized[0].data && synchronized[0].data.role === 'Sales', 'canonical command repairs the linked legacy role in the same transaction');
    check(synchronized[0] && synchronized[0].data && Object.keys(synchronized[0].data.access || {}).length === 0, 'role repair clears stale per-role access overrides');
    const changedContext = await identityAction('context', accessToken);
    const changedMembership = changedContext.body && changedContext.body.context && changedContext.body.context.memberships && changedContext.body.context.memberships[0];
    check(changedMembership && changedMembership.roleKey === 'sales', 'the existing open session sees the canonical Sales role immediately');

    // Regression gate: the provider must accept the same valid credentials on the
    // next login. The previous implementation rewrote the provider password on
    // every attempt; Supabase rejects password reuse, so login worked only once.
    const repeatLogin = await accountAction('authv2', { identifier: username, password });
    check(repeatLogin.response.status === 200 && repeatLogin.body.ok === true && repeatLogin.body.session && repeatLogin.body.session.access_token, 'the same account can obtain a second secure session');
    const repeatContext = await identityAction('context', repeatLogin.body.session.access_token);
    const repeatMembership = repeatContext.body && repeatContext.body.context && repeatContext.body.context.memberships && repeatContext.body.context.memberships[0];
    check(repeatContext.response.status === 200 && repeatMembership && repeatMembership.roleKey === 'sales', 'repeat login preserves the live canonical role');
  } finally {
    if (authUserId) {
      await fetch(`${base}/rest/v1/legacy_identity_links?auth_user_id=eq.${authUserId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
    if (authUserId) {
      await fetch(`${base}/auth/v1/admin/users/${authUserId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
    if (createdRecord) {
      await fetch(`${base}/rest/v1/records?id=eq.${encodeURIComponent(recordId)}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
    const remainingRecord = await serviceRows(`records?id=eq.${encodeURIComponent(recordId)}&select=id`);
    check(Array.isArray(remainingRecord) && remainingRecord.length === 0, 'disposable legacy account removed');
    if (authUserId) {
      const remainingProfile = await serviceRows(`profiles?id=eq.${authUserId}&select=id`);
      check(Array.isArray(remainingProfile) && remainingProfile.length === 0, 'disposable canonical identity removed');
    }
  }

  const failed = checks.filter((item) => !item.pass);
  process.stdout.write(`Full login cutover: ${checks.length - failed.length} passed, ${failed.length} failed. Canary removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Full login cutover failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
