#!/usr/bin/env node
'use strict';

// Read-only auth reconciliation report. Requires the service-role key because it
// compares server-only legacy accounts with Supabase Auth. Output uses stable
// hashes instead of names/emails and never includes credentials or row payloads.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lib = require('./_lib');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';

function parseArgs(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const separator = raw.indexOf('=');
    result[raw.slice(2, separator < 0 ? undefined : separator)] = separator < 0 ? true : raw.slice(separator + 1);
  }
  return result;
}

function safeError(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(-4000);
}

function commandJson(args) {
  const command = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (command.status !== 0) throw new Error(safeError(command.stderr || command.stdout));
  const output = String(command.stdout || '');
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

function stagingConfig(projectRef) {
  if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
    throw new Error('Refused: --project-ref must identify a non-Production Supabase project.');
  }
  const projects = commandJson(['projects', 'list', '--output', 'json']);
  const project = projects.find((candidate) => candidate.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not the healthy MAGNET OS STAGING project.');
  }
  const keys = commandJson(['projects', 'api-keys', '--project-ref', projectRef, '--output', 'json']);
  const serviceKey = keys.find((candidate) => candidate.name === 'service_role') ||
    keys.find((candidate) => candidate.type === 'secret');
  if (!serviceKey || !serviceKey.api_key) throw new Error('Staging service-role access is unavailable.');
  return { url: `https://${projectRef}.supabase.co`, key: serviceKey.api_key, keyKind: 'service_role' };
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function roleKey(value) {
  const role = normalized(value);
  if (role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  if (role === 'manager' || role === 'project manager') return 'manager';
  if (role === 'account manager') return 'account_manager';
  if (role === 'sales') return 'sales';
  if (role === 'hr') return 'hr';
  if (role === 'finance' || role === 'accountant') return 'finance';
  if (role === 'designer' || role === 'graphic designer') return 'designer';
  if (['content', 'content creator', 'video editor', 'production'].includes(role)) return 'content_creator';
  if (role === 'client') return 'client';
  return role;
}

function ref(kind, value) {
  const digest = crypto.createHash('sha256').update(normalized(value) || '(missing)').digest('hex').slice(0, 12);
  return `${kind}#${digest}`;
}

async function listAuthUsers(cfg) {
  const users = [];
  const perPage = 1000;
  for (let page = 1; page <= 1000; page++) {
    const url = `${cfg.url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const response = await fetch(url, { headers: lib.restHeaders(cfg.key) });
    if (!response.ok) throw new Error(`Auth Admin read failed (${response.status})`);
    const body = await response.json();
    const batch = Array.isArray(body) ? body : (body.users || []);
    users.push(...batch);
    if (batch.length < perPage || (body.last_page && page >= body.last_page)) break;
  }
  return users;
}

function listAuthUsersViaDatabase(projectRef) {
  const payload = commandJson([
    'db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json',
    'select id,email from auth.users order by id',
  ]);
  return Array.isArray(payload.rows) ? payload.rows : [];
}

async function readTable(cfg, table, select) {
  const response = await fetch(`${cfg.url}/rest/v1/${table}?select=${encodeURIComponent(select || '*')}`, {
    headers: lib.restHeaders(cfg.key),
  });
  if (response.status === 404) return { exists: false, rows: [] };
  if (!response.ok) throw new Error(`${table} read failed (${response.status})`);
  return { exists: true, rows: await response.json() };
}

function duplicateIssues(rows, getter, field) {
  const groups = new Map();
  for (const row of rows) {
    const value = normalized(getter(row));
    if (!value) continue;
    const list = groups.get(value) || [];
    list.push(row);
    groups.set(value, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([value, list]) => ({ type: `duplicate_${field}`, subject: ref(field, value), count: list.length }));
}

async function main() {
  const args = parseArgs(process.argv);
  let cfg;
  if (args['project-ref']) {
    cfg = stagingConfig(String(args['project-ref']));
  } else {
    lib.loadDotEnv();
    cfg = lib.getConfig();
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.keyKind !== 'service_role') {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is required. Nothing was queried or changed.');
    }
  }

  const records = await lib.fetchAllRecords(cfg);
  // `records` uses tombstones for recoverable deletes. Deleted accounts and
  // employees are historical data, not active identities, and including them
  // produces false missing-link alarms and misleading capacity counts.
  const accountRows = records.filter((row) => row.coll === '_accounts' && !(row.data && row.data._del === true));
  const employeeRows = records.filter((row) => row.coll === 'employees' && !(row.data && row.data._del === true));
  const accounts = accountRows.map((row) => ({ rowId: row.id, ...(row.data || {}) }));
  const employees = employeeRows.map((row) => ({ rowId: row.id, ...(row.data || {}) }));
  const authUsers = args['project-ref']
    ? listAuthUsersViaDatabase(String(args['project-ref']))
    : await listAuthUsers(cfg);
  const [profilesResult, membershipsResult, organizationsResult, invitationsResult] = await Promise.all([
    readTable(cfg, 'profiles', 'id,email_normalized,identity_status'),
    readTable(cfg, 'organization_members', 'id,organization_id,user_id,role_id,status'),
    readTable(cfg, 'organizations', 'id,status'),
    readTable(cfg, 'organization_invitations', 'id,organization_id,email_normalized,status,accepted_by,accepted_at'),
  ]);

  const issues = [
    ...duplicateIssues(accounts, (row) => row.email, 'legacy_email'),
    ...duplicateIssues(accounts, (row) => row.username, 'legacy_username'),
    ...duplicateIssues(authUsers, (row) => row.email, 'auth_email'),
  ];

  const authByEmail = new Map();
  for (const user of authUsers) {
    const email = normalized(user.email);
    if (!email) continue;
    const list = authByEmail.get(email) || [];
    list.push(user);
    authByEmail.set(email, list);
  }
  const accountById = new Map(accounts.map((row) => [String(row.id || ''), row]));
  const employeeById = new Map(employees.map((row) => [row.rowId, row]));

  for (const account of accounts) {
    const subject = ref('legacy_account', account.id || account.rowId);
    const email = normalized(account.email);
    const matches = email ? (authByEmail.get(email) || []) : [];
    if (!email) issues.push({ type: 'legacy_account_missing_email', subject });
    else if (matches.length === 0) issues.push({ type: 'legacy_account_missing_auth_identity', subject });
    else if (matches.length > 1) issues.push({ type: 'legacy_account_ambiguous_auth_identity', subject, count: matches.length });

    const employee = account.employeeId ? employeeById.get(account.employeeId) : null;
    if (!employee) issues.push({ type: 'legacy_account_missing_employee_link', subject });
    else if (roleKey(employee.appRole || employee.role) !== roleKey(account.role)) {
      issues.push({ type: 'legacy_account_employee_role_mismatch', subject });
    }
  }

  for (const employee of employees) {
    const subject = ref('employee', employee.rowId);
    const userId = String(employee.userId || '').trim();
    if (!userId) issues.push({ type: 'employee_missing_account_link', subject });
    else if (!accountById.has(userId)) issues.push({ type: 'employee_link_references_missing_account', subject });
  }

  if (profilesResult.exists) {
    const profiles = profilesResult.rows;
    const profileByUser = new Map(profiles.map((row) => [row.id, row]));
    const authById = new Map(authUsers.map((row) => [row.id, row]));
    const membershipByUser = new Map();
    for (const membership of membershipsResult.rows) {
      const list = membershipByUser.get(membership.user_id) || [];
      list.push(membership);
      membershipByUser.set(membership.user_id, list);
    }
    const orgById = new Map(organizationsResult.rows.map((row) => [row.id, row]));

    for (const user of authUsers) {
      if (!profileByUser.has(user.id)) issues.push({ type: 'auth_identity_missing_profile', subject: ref('auth_user', user.id) });
    }
    for (const profile of profiles) {
      const subject = ref('profile', profile.id);
      if (!authById.has(profile.id)) issues.push({ type: 'profile_missing_auth_identity', subject });
      const memberships = membershipByUser.get(profile.id) || [];
      if (profile.identity_status === 'ACTIVE' && !memberships.some((row) => row.status === 'ACTIVE')) {
        issues.push({ type: 'active_profile_missing_active_membership', subject });
      }
      for (const membership of memberships) {
        const org = orgById.get(membership.organization_id);
        if (!org) issues.push({ type: 'membership_missing_organization', subject });
        else if (membership.status === 'ACTIVE' && org.status !== 'ACTIVE') {
          issues.push({ type: 'active_membership_in_inactive_organization', subject });
        }
      }
    }

    const acceptedInvites = invitationsResult.rows.filter((row) => row.status === 'ACCEPTED');
    for (const invite of acceptedInvites) {
      const hasMembership = invite.accepted_by && membershipsResult.rows.some((row) =>
        row.user_id === invite.accepted_by && row.organization_id === invite.organization_id
      );
      if (!hasMembership) issues.push({ type: 'accepted_invite_missing_membership', subject: ref('invite', invite.id) });
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    read_only: true,
    counts: {
      legacy_accounts: accounts.length,
      employees: employees.length,
      auth_users: authUsers.length,
      profiles: profilesResult.exists ? profilesResult.rows.length : null,
      memberships: membershipsResult.exists ? membershipsResult.rows.length : null,
      organizations: organizationsResult.exists ? organizationsResult.rows.length : null,
      invitations: invitationsResult.exists ? invitationsResult.rows.length : null,
      issues: issues.length,
    },
    normalized_schema_applied: profilesResult.exists,
    issues,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (issues.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ read_only: true, error: error && error.message ? error.message : String(error) }));
  process.exitCode = 2;
});
