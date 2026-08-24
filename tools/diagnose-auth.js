#!/usr/bin/env node
'use strict';

// Read-only auth reconciliation report. Requires the service-role key because it
// compares server-only legacy accounts with Supabase Auth. Output uses stable
// hashes instead of names/emails and never includes credentials or row payloads.

const crypto = require('node:crypto');
const lib = require('./_lib');

function normalized(value) {
  return String(value || '').trim().toLowerCase();
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
  lib.loadDotEnv();
  const cfg = lib.getConfig();
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.keyKind !== 'service_role') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required. Nothing was queried or changed.');
  }

  const records = await lib.fetchAllRecords(cfg);
  const accountRows = records.filter((row) => row.coll === '_accounts');
  const employeeRows = records.filter((row) => row.coll === 'employees');
  const accounts = accountRows.map((row) => ({ rowId: row.id, ...(row.data || {}) }));
  const employees = employeeRows.map((row) => ({ rowId: row.id, ...(row.data || {}) }));
  const authUsers = await listAuthUsers(cfg);
  const [profilesResult, membershipsResult, organizationsResult, invitationsResult] = await Promise.all([
    readTable(cfg, 'profiles', 'user_id,email_normalized,status'),
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
    else if (normalized(employee.appRole || employee.role) !== normalized(account.role)) {
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
    const profileByUser = new Map(profiles.map((row) => [row.user_id, row]));
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
      const subject = ref('profile', profile.user_id);
      if (!authById.has(profile.user_id)) issues.push({ type: 'profile_missing_auth_identity', subject });
      const memberships = membershipByUser.get(profile.user_id) || [];
      if (profile.status === 'ACTIVE' && !memberships.some((row) => row.status === 'ACTIVE')) {
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
