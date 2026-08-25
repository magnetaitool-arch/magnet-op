#!/usr/bin/env node
'use strict';

/**
 * Reproduce the current security/auth baseline on a verified Staging project.
 * Production is explicitly refused. Public-policy mutations are wrapped in
 * transactions and rolled back. The temporary login account is removed in a
 * finally block, including its Staging-only Auth identity/session.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const pos = raw.indexOf('=');
    if (pos === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, pos)] = raw.slice(pos + 1);
  }
  return out;
}

function safeError(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(-2000);
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function command(cliJs, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0 && !allowFailure) throw new Error(safeError(result.stderr || result.stdout));
  return result;
}

function parseJsonOutput(stdout) {
  const value = String(stdout || '');
  const arrayStart = value.indexOf('[');
  const objectStart = value.indexOf('{');
  const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) throw new Error('Command returned no JSON payload.');
  return JSON.parse(value.slice(start));
}

function commandJson(cliJs, args) {
  return parseJsonOutput(command(cliJs, args).stdout);
}

function sql(cliJs, projectRef, statement, { allowFailure = false } = {}) {
  const result = command(cliJs, [
    'db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', statement,
  ], { allowFailure });
  if (result.status !== 0) return { ok: false, rows: [], error: safeError(result.stderr || result.stdout) };
  const payload = parseJsonOutput(result.stdout);
  return { ok: true, rows: Array.isArray(payload.rows) ? payload.rows : [] };
}

async function postJson(url, apiKey, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256');
  return `pbkdf2$150000$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function main() {
const args = parseArgs(process.argv);
const productionRef = String(args['production-ref'] || '').trim();
const stagingRef = String(args['staging-ref'] || '').trim();
const expectedStagingName = String(args['expected-staging-name'] || 'MAGNET OS STAGING');
const backupDir = path.resolve(String(args['backup-dir'] || ''));
const cliJs = path.resolve(String(args['cli-js'] || ''));

if (!/^[a-z]{20}$/.test(productionRef) || !/^[a-z]{20}$/.test(stagingRef) || productionRef === stagingRef) {
  console.error('REFUSED: explicit, different Production and Staging refs are required.');
  process.exit(2);
}
if (!args['backup-dir'] || !backupDir.includes(`${path.sep}backups${path.sep}`)) {
  console.error('ERROR: --backup-dir must be an explicit path under backups/.');
  process.exit(2);
}
if (!fs.existsSync(cliJs)) {
  console.error('ERROR: Supabase CLI entrypoint not found.');
  process.exit(2);
}

const projects = commandJson(cliJs, ['projects', 'list', '--output', 'json']);
const staging = projects.find((project) => project.ref === stagingRef);
if (!staging || staging.name !== expectedStagingName || staging.status !== 'ACTIVE_HEALTHY') {
  console.error('REFUSED: Staging project identity/name/health check failed.');
  process.exit(2);
}

const apiKeys = commandJson(cliJs, ['projects', 'api-keys', '--project-ref', stagingRef, '--output', 'json']);
const publishable = apiKeys.find((key) => key.type === 'publishable') || apiKeys.find((key) => key.name === 'anon');
const apiKey = publishable && publishable.api_key;
if (!apiKey || (!String(apiKey).startsWith('sb_publishable_') && !String(apiKey).startsWith('eyJ'))) {
  console.error('ERROR: Could not obtain the Staging publishable/anon key through authenticated CLI.');
  process.exit(2);
}

const anonRead = sql(cliJs, stagingRef, `
  begin;
  set local role anon;
  select
    (select count(*)::bigint from public.accounts_safe) as accounts_safe_rows,
    (select count(*)::bigint from public.records where coll='_accounts') as direct_account_rows,
    (select count(*)::bigint from public.records where coll='clients') as clients,
    (select count(*)::bigint from public.records where coll='employees') as employees,
    (select count(*)::bigint from public.records where coll='tasks') as tasks,
    (select count(*)::bigint from public.records where coll in ('payments','invoices','employeePayments','expenses','fixedCosts','partnerSettlements')) as finance_rows;
  rollback;
`);
if (!anonRead.ok || !anonRead.rows.length) throw new Error('Anonymous read baseline could not be measured.');

const authenticatedRead = sql(cliJs, stagingRef, `
  begin;
  set local role authenticated;
  select
    (select count(*)::bigint from public.accounts_safe) as accounts_safe_rows,
    (select count(*)::bigint from public.records where coll='clients') as clients,
    (select count(*)::bigint from public.records where coll='employees') as employees,
    (select count(*)::bigint from public.records where coll='tasks') as tasks;
  rollback;
`);

const publicInsert = sql(cliJs, stagingRef, `
  begin;
  set local role anon;
  with inserted as (
    insert into public.records(id,coll,data)
    values ('__m0_public_insert_probe__','briefs','{"m0_probe":true}'::jsonb)
    returning id
  ) select count(*)::bigint as affected from inserted;
  rollback;
`);
const privateInsert = sql(cliJs, stagingRef, `
  begin;
  set local role anon;
  with inserted as (
    insert into public.records(id,coll,data)
    values ('__m0_private_insert_probe__','clients','{"m0_probe":true}'::jsonb)
    returning id
  ) select count(*)::bigint as affected from inserted;
  rollback;
`, { allowFailure: true });
const publicUpdate = sql(cliJs, stagingRef, `
  begin;
  set local role anon;
  with target as (select id from public.records where coll='clients' order by id limit 1),
  changed as (
    update public.records r set data=r.data || '{"__m0_probe":true}'::jsonb
    from target where r.id=target.id returning r.id
  ) select count(*)::bigint as affected from changed;
  rollback;
`);
const publicDelete = sql(cliJs, stagingRef, `
  begin;
  set local role anon;
  with target as (select id from public.records where coll='clients' order by id limit 1),
  removed as (
    delete from public.records r using target where r.id=target.id returning r.id
  ) select count(*)::bigint as affected from removed;
  rollback;
`);

const roleInventory = sql(cliJs, stagingRef, `
  with accounts as (
    select data from public.records where coll='_accounts'
  ), role_counts as (
    select coalesce(nullif(data->>'role',''),'UNSET') as role,count(*)::bigint as count
    from accounts group by 1 order by 1
  ), duplicate_emails as (
    select lower(trim(data->>'email')) as value from accounts
    where coalesce(trim(data->>'email'),'')<>'' group by 1 having count(*)>1
  ), duplicate_usernames as (
    select lower(trim(data->>'username')) as value from accounts
    where coalesce(trim(data->>'username'),'')<>'' group by 1 having count(*)>1
  )
  select
    (select jsonb_object_agg(role,count) from role_counts) as role_counts,
    (select count(*)::bigint from duplicate_emails) as duplicate_email_groups,
    (select count(*)::bigint from duplicate_usernames) as duplicate_username_groups
`);

const canarySuffix = crypto.randomBytes(8).toString('hex');
const canaryId = `m0-canary-${canarySuffix}`;
const canaryUsername = `m0.canary.${canarySuffix}`;
const canaryEmail = `m0-canary-${canarySuffix}@example.invalid`;
const canaryPassword = `M0OnlyAa${crypto.randomBytes(12).toString('hex')}`;
const canaryData = {
  id: canaryId,
  name: 'M0 Staging Canary',
  username: canaryUsername,
  email: canaryEmail,
  role: 'Sales',
  status: 'Active',
  verified: true,
  isDefaultPassword: false,
  access: {},
  passwordHash: passwordHash(canaryPassword),
};
const functionUrl = `https://${stagingRef}.supabase.co/functions/v1/accounts`;
let authBaseline;
let cleanupVerified = false;

try {
  const insertCanary = sql(cliJs, stagingRef, `
    insert into public.records(id,coll,data)
    values (${quoteLiteral(`acct-${canaryId}`)},'_accounts',${quoteLiteral(JSON.stringify(canaryData))}::jsonb)
  `);
  if (!insertCanary.ok) throw new Error('Could not create isolated Staging login canary.');

  const health = await postJson(functionUrl, apiKey, { action: 'health' });
  const unauthorizedList = await postJson(functionUrl, apiKey, { action: 'list', token: 'invalid' });
  const legacyLogin = await postJson(functionUrl, apiKey, { action: 'login', identifier: canaryUsername, password: canaryPassword });
  const legacyToken = legacyLogin.payload && legacyLogin.payload.token;
  const initialRole = legacyLogin.payload && legacyLogin.payload.user && legacyLogin.payload.user.role;
  if (!legacyToken) throw new Error('Staging legacy login did not issue a token.');

  const roleChange = sql(cliJs, stagingRef, `
    update public.records set data=jsonb_set(data,'{role}','"Content"'::jsonb,true)
    where id=${quoteLiteral(`acct-${canaryId}`)} and coll='_accounts'
  `);
  if (!roleChange.ok) throw new Error('Could not exercise live-role baseline.');
  const meAfterRoleChange = await postJson(functionUrl, apiKey, { action: 'me', token: legacyToken });
  const liveRole = meAfterRoleChange.payload && meAfterRoleChange.payload.user && meAfterRoleChange.payload.user.role;

  const authV2 = await postJson(functionUrl, apiKey, { action: 'authv2', identifier: canaryUsername, password: canaryPassword });
  authBaseline = {
    health_ok: health.status === 200 && health.payload.ok === true && health.payload.database === 'reachable',
    needs_setup: health.payload.needsSetup,
    unauthorized_admin_list_rejected: unauthorizedList.status === 401,
    legacy_login_ok: legacyLogin.status === 200 && legacyLogin.payload.ok === true,
    legacy_login_initial_role: initialRole,
    live_role_refresh_ok: meAfterRoleChange.status === 200 && liveRole === 'Content',
    live_role_after_change: liveRole,
    auth_v2_session_ok: authV2.status === 200 && authV2.payload.ok === true && Boolean(authV2.payload.session && authV2.payload.session.access_token),
  };
} finally {
  sql(cliJs, stagingRef, `
    delete from auth.users where lower(email)=lower(${quoteLiteral(canaryEmail)});
    delete from public.records where id=${quoteLiteral(`acct-${canaryId}`)} and coll='_accounts';
  `, { allowFailure: true });
  const cleanup = sql(cliJs, stagingRef, `
    select
      (select count(*)::bigint from public.records where id=${quoteLiteral(`acct-${canaryId}`)}) as account_rows,
      (select count(*)::bigint from auth.users where lower(email)=lower(${quoteLiteral(canaryEmail)})) as auth_users,
      (select count(*)::bigint from auth.identities i join auth.users u on u.id=i.user_id where lower(u.email)=lower(${quoteLiteral(canaryEmail)})) as identities
  `);
  cleanupVerified = cleanup.ok && cleanup.rows.length === 1 &&
    Number(cleanup.rows[0].account_rows) === 0 && Number(cleanup.rows[0].auth_users) === 0 && Number(cleanup.rows[0].identities) === 0;
}

const read = anonRead.rows[0];
const report = {
  format: 'magnet-os-m0-security-baseline',
  created_at: new Date().toISOString(),
  project: { ref: stagingRef, name: staging.name, status: staging.status },
  production_touched: false,
  anonymous_read: {
    accounts_safe_rows: Number(read.accounts_safe_rows),
    direct_account_rows: Number(read.direct_account_rows),
    clients: Number(read.clients),
    employees: Number(read.employees),
    tasks: Number(read.tasks),
    finance_rows: Number(read.finance_rows),
  },
  authenticated_read_without_user_claims: authenticatedRead.ok && authenticatedRead.rows.length ? authenticatedRead.rows[0] : null,
  anonymous_mutation: {
    public_intake_insert_allowed: publicInsert.ok && Number(publicInsert.rows[0] && publicInsert.rows[0].affected) === 1,
    private_client_insert_allowed: privateInsert.ok && Number(privateInsert.rows[0] && privateInsert.rows[0].affected) === 1,
    private_client_update_allowed: publicUpdate.ok && Number(publicUpdate.rows[0] && publicUpdate.rows[0].affected) === 1,
    private_client_delete_allowed: publicDelete.ok && Number(publicDelete.rows[0] && publicDelete.rows[0].affected) === 1,
    all_policy_probes_rolled_back: true,
  },
  auth: authBaseline,
  roles: roleInventory.rows[0] || null,
  canary_cleanup_verified: cleanupVerified,
  findings: {
    anonymous_accounts_safe_exposure: Number(read.accounts_safe_rows) > 0,
    anonymous_private_business_reads: Number(read.clients) + Number(read.employees) + Number(read.tasks) + Number(read.finance_rows) > 0,
    anonymous_public_writes_exist: publicInsert.ok && Number(publicInsert.rows[0] && publicInsert.rows[0].affected) === 1,
    anonymous_private_updates_exist: publicUpdate.ok && Number(publicUpdate.rows[0] && publicUpdate.rows[0].affected) === 1,
    anonymous_private_deletes_exist: publicDelete.ok && Number(publicDelete.rows[0] && publicDelete.rows[0].affected) === 1,
  },
};

const reportFile = path.join(backupDir, 'staging-security-baseline.json');
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportFile, 0o600);

console.log('Staging security baseline captured.');
console.log(`Anonymous accounts_safe exposure: ${report.findings.anonymous_accounts_safe_exposure}`);
console.log(`Anonymous private business reads: ${report.findings.anonymous_private_business_reads}`);
console.log(`Anonymous public writes: ${report.findings.anonymous_public_writes_exist}`);
console.log(`Anonymous private updates: ${report.findings.anonymous_private_updates_exist}`);
console.log(`Anonymous private deletes: ${report.findings.anonymous_private_deletes_exist}`);
console.log(`Legacy login test: ${Boolean(authBaseline && authBaseline.legacy_login_ok)}`);
console.log(`Auth v2 session test: ${Boolean(authBaseline && authBaseline.auth_v2_session_ok)}`);
console.log(`Live role refresh test: ${Boolean(authBaseline && authBaseline.live_role_refresh_ok)}`);
console.log(`Canary cleanup verified: ${cleanupVerified}`);
console.log(`Private report: ${reportFile}`);

if (!cleanupVerified || !authBaseline || !authBaseline.health_ok || !authBaseline.legacy_login_ok || !authBaseline.auth_v2_session_ok) {
  process.exit(1);
}
}

main().catch((error) => {
  console.error(`M0 staging baseline failed: ${safeError(error && error.message)}`);
  process.exit(1);
});
