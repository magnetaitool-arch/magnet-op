#!/usr/bin/env node
'use strict';

// End-to-end Staging-only identity test. Uses disposable synthetic users and
// never prints credentials, tokens, emails, or database payloads.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
const ALLOWED_ORIGIN = 'https://magnet-os-staging.vercel.app';

function parseArgs(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const separator = raw.indexOf('=');
    result[raw.slice(2, separator < 0 ? undefined : separator)] = separator < 0 ? true : raw.slice(separator + 1);
  }
  return result;
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

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const args = parseArgs(process.argv);
  const projectRef = String(args['project-ref'] || '').trim();
  if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
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
  const ownerEmail = `identity-owner-${suffix}@example.invalid`;
  const targetEmail = `identity-target-${suffix}@example.invalid`;
  const ownerPassword = `OwnerAa1-${crypto.randomBytes(18).toString('base64url')}`;
  const targetPassword = `TargetAa1-${crypto.randomBytes(18).toString('base64url')}`;
  const createdUserIds = [];
  const assertions = [];
  let currentStage = 'initialization';
  const check = (condition, label) => {
    assertions.push({ label, pass: !!condition });
    if (!condition) throw new Error(`Assertion failed: ${label}`);
  };

  async function createUser(email, password, displayName) {
    const result = await jsonFetch(`${base}/auth/v1/admin/users`, {
      method: 'POST', headers: serviceHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: displayName } }),
    });
    check(result.response.status === 200 && result.body && result.body.id, 'disposable Auth user created');
    createdUserIds.push(result.body.id);
    return result.body.id;
  }

  async function serviceRows(path, init = {}) {
    const result = await jsonFetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers || {}) } });
    if (!result.response.ok) {
      const category = result.body && (result.body.code || result.body.message) ? String(result.body.code || result.body.message) : 'unknown';
      throw new Error(`${currentStage}: Staging service request failed (${result.response.status}, ${category})`);
    }
    return result.body;
  }

  async function signIn(email, password) {
    const result = await jsonFetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: publishable.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    check(result.response.status === 200 && result.body.access_token, 'Supabase password session issued');
    return result.body.access_token;
  }

  async function identity(action, token, payload = {}, origin = ALLOWED_ORIGIN) {
    return await jsonFetch(`${base}/functions/v1/identity`, {
      method: 'POST',
      headers: {
        apikey: publishable.api_key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json', Origin: origin,
      },
      body: JSON.stringify({ action, ...payload }),
    });
  }

  try {
    currentStage = 'public endpoint checks';
    const health = await identity('health', '');
    check(health.response.status === 200 && health.body.ok === true, 'identity health endpoint');
    const disallowed = await identity('health', '', {}, 'https://attacker.invalid');
    check(disallowed.response.status === 403, 'unapproved browser origin rejected');
    const unauthorized = await identity('context', '');
    check(unauthorized.response.status === 401, 'missing JWT rejected');

    currentStage = 'create disposable identities';
    const ownerId = await createUser(ownerEmail, ownerPassword, 'Identity Owner Canary');
    const targetId = await createUser(targetEmail, targetPassword, 'Identity Target Canary');
    const organizations = await serviceRows('organizations?slug=eq.magnet&select=id&limit=1');
    check(Array.isArray(organizations) && organizations[0], 'Magnet organization exists');
    const organizationId = organizations[0].id;
    const roles = await serviceRows(`organization_roles?organization_id=eq.${organizationId}&key=in.(owner,sales)&select=id,key`);
    const roleByKey = new Map(roles.map((role) => [role.key, role.id]));
    check(roleByKey.has('owner') && roleByKey.has('sales'), 'canonical test roles exist');

    currentStage = 'activate disposable profiles';
    await serviceRows(`profiles?id=in.(${ownerId},${targetId})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ identity_status: 'ACTIVE', onboarding_status: 'COMPLETED' }),
    });
    currentStage = 'create disposable memberships';
    await serviceRows('organization_members?on_conflict=organization_id,user_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([
        { organization_id: organizationId, user_id: ownerId, role_id: roleByKey.get('owner'), status: 'ACTIVE', joined_at: new Date().toISOString() },
        { organization_id: organizationId, user_id: targetId, role_id: roleByKey.get('sales'), status: 'ACTIVE', joined_at: new Date().toISOString() },
      ]),
    });

    currentStage = 'issue sessions';
    const ownerToken = await signIn(ownerEmail, ownerPassword);
    const targetToken = await signIn(targetEmail, targetPassword);
    currentStage = 'resolve owner context';
    const ownerContext = await identity('context', ownerToken);
    check(ownerContext.response.status === 200 && ownerContext.body.context.memberships[0].roleKey === 'owner', 'owner context resolved from live membership');
    const members = await identity('members', ownerToken, { organizationId });
    check(members.response.status === 200 && Array.isArray(members.body.members), 'authorized member directory');

    currentStage = 'update target role';
    const roleChange = await identity('update_membership', ownerToken, {
      organizationId, userId: targetId, roleKey: 'content_creator', status: 'ACTIVE',
    });
    check(roleChange.response.status === 200 && roleChange.body.ok === true, 'transactional role change');
    const changedContext = await identity('context', targetToken);
    const changedMembership = changedContext.body && changedContext.body.context && changedContext.body.context.memberships[0];
    check(changedContext.response.status === 200 && changedMembership && changedMembership.roleKey === 'content_creator', 'open session sees changed role without cache repair');

    currentStage = 'disable target membership';
    const disable = await identity('update_membership', ownerToken, {
      organizationId, userId: targetId, roleKey: 'content_creator', status: 'DISABLED',
    });
    check(disable.response.status === 200, 'membership deactivation command');
    const disabledContext = await identity('context', targetToken);
    check(disabledContext.response.status === 403 && disabledContext.body.error === 'membership_missing', 'deactivated member loses organization access immediately');
  } finally {
    let cleanupFailures = 0;
    for (const userId of createdUserIds.reverse()) {
      const cleanup = await fetch(`${base}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
      if (!cleanup || !cleanup.ok) cleanupFailures++;
    }
    if (cleanupFailures) throw new Error(`Disposable identity cleanup failed (${cleanupFailures})`);
  }

  const failed = assertions.filter((assertion) => !assertion.pass);
  process.stdout.write(`Identity E2E: ${assertions.length - failed.length} passed, ${failed.length} failed. Disposable users removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Identity E2E failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
