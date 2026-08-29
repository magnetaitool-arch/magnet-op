#!/usr/bin/env node
'use strict';

// Live employee-privacy canary for MAGNET OS STAGING only. It proves that a
// normal team member receives a sanitized directory, can read their own full
// employee row, and cannot read another employee's private JSON. All synthetic
// identities, organizations, and records are removed before exit.

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
  const identities = [];
  const recordIds = [];
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

  async function createIdentity(roleKey, roleId, organizationId, employeeId) {
    const email = `employee-privacy-${roleKey}-${suffix}@example.invalid`;
    const password = `PrivacyAa1-${crypto.randomBytes(18).toString('base64url')}`;
    const created = await jsonFetch(`${base}/auth/v1/admin/users`, {
      method: 'POST', headers: serviceHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `Privacy ${roleKey} Canary` } }),
    });
    check(created.response.status === 200 && created.body.id, `disposable ${roleKey} identity created`);
    const identity = { id: created.body.id, email, password, roleKey };
    identities.push(identity);
    await serviceRows(`profiles?id=eq.${identity.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ identity_status: 'ACTIVE', onboarding_status: 'COMPLETED', employee_id: employeeId || null }),
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
    const roles = await serviceRows(`organization_roles?organization_id=eq.${organizationId}&key=in.(content_creator,hr,client)&select=id,key`);
    const roleByKey = new Map(roles.map((role) => [role.key, role.id]));
    check(roleByKey.has('content_creator') && roleByKey.has('hr') && roleByKey.has('client'), 'content, HR, and client roles exist');

    const selfEmployeeId = `privacy-self-${suffix}`;
    const otherEmployeeId = `privacy-other-${suffix}`;
    const crossEmployeeId = `privacy-cross-${suffix}`;
    recordIds.push(selfEmployeeId, otherEmployeeId, crossEmployeeId);
    const content = await createIdentity('content_creator', roleByKey.get('content_creator'), organizationId, selfEmployeeId);
    const hr = await createIdentity('hr', roleByKey.get('hr'), organizationId, null);
    const client = await createIdentity('client', roleByKey.get('client'), organizationId, null);

    const secondOrganization = await serviceRows('organizations', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name: 'Employee Privacy Canary', slug: `employee-privacy-${suffix}`, status: 'ACTIVE', timezone: 'Africa/Cairo', locale: 'en' }),
    });
    secondOrganizationId = secondOrganization[0].id;

    const sensitiveData = (id, fullName) => ({
      id, fullName, jobTitle: 'Synthetic Role', departmentId: 'synthetic', employmentType: 'Full-time',
      status: 'Active', workMode: 'Office', managerId: '', capacityPerWeek: 40, skills: ['QA'], appRole: 'Content Creator',
      salary: 987654, bankAccount: 'SYNTHETIC-PRIVATE', bankName: 'Synthetic Bank', nationalId: 'PRIVATE-ID',
      nationalIdLink: 'https://example.invalid/private', email: 'private@example.invalid', phone: '+0000000000',
      notes: 'PRIVATE NOTES', performanceScore: 99, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const rows = [
      { id: selfEmployeeId, coll: 'employees', organization_id: organizationId, data: sensitiveData(selfEmployeeId, 'Self Privacy Canary') },
      { id: otherEmployeeId, coll: 'employees', organization_id: organizationId, data: sensitiveData(otherEmployeeId, 'Other Privacy Canary') },
      { id: crossEmployeeId, coll: 'employees', organization_id: secondOrganizationId, data: sensitiveData(crossEmployeeId, 'Cross Privacy Canary') },
    ];
    await serviceRows('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });

    const contentSelf = await userRequest(content, `records?id=eq.${selfEmployeeId}&select=id,data`);
    check(contentSelf.response.status === 200 && contentSelf.body.length === 1 && contentSelf.body[0].data.salary === 987654, 'employee can read their own full private row');
    const contentOther = await userRequest(content, `records?id=eq.${otherEmployeeId}&select=id,data`);
    check(contentOther.response.status === 200 && contentOther.body.length === 0, 'employee cannot read another full employee row');

    const directory = await userRequest(content, 'rpc/employee_directory', {
      method: 'POST', body: JSON.stringify({ p_organization_id: organizationId, p_since: null }),
    });
    check(directory.response.status === 200 && Array.isArray(directory.body), 'normal member can load the tenant employee directory');
    const otherDirectory = directory.body.find((row) => row.id === otherEmployeeId);
    check(otherDirectory && otherDirectory.data.fullName === 'Other Privacy Canary', 'directory contains assignment-safe employee identity');
    const privateKeys = ['salary', 'bankAccount', 'bankName', 'nationalId', 'nationalIdLink', 'email', 'phone', 'notes', 'performanceScore'];
    check(privateKeys.every((key) => !Object.prototype.hasOwnProperty.call(otherDirectory.data, key)), 'directory response contains no private employee fields');
    check(otherDirectory.data._directoryOnly === true, 'directory response is marked redacted');

    const hrOther = await userRequest(hr, `records?id=eq.${otherEmployeeId}&select=id,data`);
    check(hrOther.response.status === 200 && hrOther.body.length === 1 && hrOther.body[0].data.bankAccount === 'SYNTHETIC-PRIVATE', 'HR can read the full employee record');

    const anonDirectory = await jsonFetch(`${base}/rest/v1/rpc/employee_directory`, {
      method: 'POST', headers: anonHeaders, body: JSON.stringify({ p_organization_id: organizationId, p_since: null }),
    });
    check([401, 403, 404].includes(anonDirectory.response.status), 'anonymous directory access rejected');
    const clientDirectory = await userRequest(client, 'rpc/employee_directory', {
      method: 'POST', body: JSON.stringify({ p_organization_id: organizationId, p_since: null }),
    });
    check([401, 403].includes(clientDirectory.response.status), 'client portal cannot enumerate the employee directory');
    const crossDirectory = await userRequest(content, 'rpc/employee_directory', {
      method: 'POST', body: JSON.stringify({ p_organization_id: secondOrganizationId, p_since: null }),
    });
    check([401, 403].includes(crossDirectory.response.status), 'cross-tenant directory access rejected');

    const future = new Date(Date.now() + 60_000).toISOString();
    const emptyDelta = await userRequest(content, 'rpc/employee_directory', {
      method: 'POST', body: JSON.stringify({ p_organization_id: organizationId, p_since: future }),
    });
    check(emptyDelta.response.status === 200 && Array.isArray(emptyDelta.body) && emptyDelta.body.length === 0, 'directory delta cursor returns only newer changes');
  } finally {
    for (const recordId of recordIds) {
      await fetch(`${base}/rest/v1/records?id=eq.${encodeURIComponent(recordId)}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
    if (secondOrganizationId) {
      await fetch(`${base}/rest/v1/organizations?id=eq.${secondOrganizationId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
    for (const identity of identities.reverse()) {
      await fetch(`${base}/auth/v1/admin/users/${identity.id}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    }
  }

  const remaining = await jsonFetch(`${base}/rest/v1/records?id=like.privacy-*-${suffix}&select=id`, { headers: serviceHeaders });
  check(remaining.response.ok && Array.isArray(remaining.body) && remaining.body.length === 0, 'all employee privacy canaries removed');
  const failed = assertions.filter((assertion) => !assertion.pass);
  process.stdout.write(`Employee privacy E2E: ${assertions.length - failed.length} passed, ${failed.length} failed. Synthetic users and records removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Employee privacy E2E failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
