#!/usr/bin/env node
'use strict';

// Idempotent MAGNET OS STAGING reconciliation. It converts the deliberately
// disabled M0 Auth placeholders into email identities, seeds the Magnet tenant,
// canonical roles/capabilities/memberships, and legacy link evidence. It never
// creates or changes a password and refuses the Production project.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
const ROOT = path.resolve(__dirname, '..');

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
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(-6000);
}

function runSupabase(args) {
  const command = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (command.status !== 0) throw new Error(safeText(command.stderr || command.stdout));
  return String(command.stdout || '');
}

function parseJsonOutput(output) {
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

function query(projectRef, sql) {
  const payload = parseJsonOutput(runSupabase([
    'db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql,
  ]));
  return Array.isArray(payload.rows) ? payload.rows : [];
}

const RECONCILIATION_SQL = String.raw`
begin;

do $$
begin
  if to_regclass('public.organization_members') is null or to_regclass('public.login_aliases') is null then
    raise exception 'M1 identity migrations are not applied';
  end if;
  if exists (
    select 1 from public.profiles
    where email_normalized is null or email_normalized = ''
  ) then
    raise exception 'profile with missing normalized email';
  end if;
  if exists (
    select 1 from public.profiles group by email_normalized having count(*) > 1
  ) then
    raise exception 'duplicate canonical profile email';
  end if;
  if exists (
    select 1
    from public.profiles profile
    join auth.users auth_user on lower(btrim(auth_user.email)) = profile.email_normalized
    where auth_user.id <> profile.id
  ) then
    raise exception 'canonical email belongs to a different Auth identity';
  end if;
end $$;

-- M0 intentionally restored Auth users without Production passwords or live
-- sessions. The original placeholder insert also left four legacy GoTrue token
-- columns NULL. GoTrue's Admin update path scans those columns as strings before
-- it can set the verified legacy password, so the first secure login failed with
-- provider_password_update_failed. Normalize only confirmed, passwordless
-- Staging identities. No password, credential, or Production row is copied.
update auth.users auth_user
set
  confirmation_token = coalesce(auth_user.confirmation_token, ''),
  recovery_token = coalesce(auth_user.recovery_token, ''),
  email_change_token_new = coalesce(auth_user.email_change_token_new, ''),
  email_change = coalesce(auth_user.email_change, ''),
  updated_at = now()
from public.legacy_identity_links legacy_link
where legacy_link.auth_user_id = auth_user.id
  and legacy_link.link_status = 'CONFIRMED'
  and nullif(auth_user.encrypted_password, '') is null;

update auth.users auth_user
set
  email = profile.email_normalized,
  email_confirmed_at = coalesce(auth_user.email_confirmed_at, now()),
  raw_app_meta_data = coalesce(auth_user.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'staging_placeholder', false),
  updated_at = now()
from public.profiles profile
where auth_user.id = profile.id
  and coalesce(auth_user.raw_app_meta_data->>'staging_placeholder', 'false') = 'true';

insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  profile.id::text,
  profile.id,
  jsonb_build_object('sub', profile.id::text, 'email', profile.email_normalized, 'email_verified', true),
  'email',
  null,
  now(),
  now()
from public.profiles profile
join auth.users auth_user on auth_user.id = profile.id
on conflict (provider_id, provider) do update
set
  user_id = excluded.user_id,
  identity_data = excluded.identity_data,
  updated_at = now();

insert into public.organizations (name, slug, status, timezone, locale)
select 'Magnet', 'magnet', 'ACTIVE', 'Africa/Cairo', 'en'
where not exists (select 1 from public.organizations where slug = 'magnet');

with role_seed(key, name, description) as (
  values
    ('owner', 'Owner', 'Organization owner with all capabilities'),
    ('admin', 'Admin', 'Organization administrator'),
    ('manager', 'Manager', 'Operations and delivery manager'),
    ('sales', 'Sales', 'Sales and CRM team member'),
    ('content_creator', 'Content Creator', 'Content production team member'),
    ('designer', 'Designer', 'Creative design team member'),
    ('account_manager', 'Account Manager', 'Client relationship manager'),
    ('hr', 'HR', 'People operations team member'),
    ('finance', 'Finance', 'Finance team member'),
    ('client', 'Client', 'External client workspace member')
)
insert into public.organization_roles (organization_id, key, name, description, is_system)
select organization.id, role_seed.key, role_seed.name, role_seed.description, false
from public.organizations organization
cross join role_seed
where organization.slug = 'magnet'
  and not exists (
    select 1 from public.organization_roles existing_role
    where existing_role.organization_id = organization.id and existing_role.key = role_seed.key
  );

insert into public.role_capabilities (role_id, capability_id)
select organization_role.id, capability.id
from public.organization_roles organization_role
join public.organizations organization on organization.id = organization_role.organization_id and organization.slug = 'magnet'
cross join public.capabilities capability
where organization_role.key in ('owner','admin')
on conflict do nothing;

with role_capability_seed(role_key, capability_key) as (
  values
    ('manager','clients.read'), ('manager','clients.manage'), ('manager','work.read'), ('manager','work.manage'),
    ('manager','approvals.manage'), ('manager','reports.read'), ('manager','reports.manage'), ('manager','hr.read'), ('manager','audit.read'),
    ('sales','clients.read'), ('sales','clients.manage'), ('sales','work.read'), ('sales','reports.read'),
    ('content_creator','work.read'), ('content_creator','work.manage'),
    ('designer','work.read'), ('designer','work.manage'),
    ('account_manager','clients.read'), ('account_manager','clients.manage'), ('account_manager','work.read'),
    ('account_manager','work.manage'), ('account_manager','approvals.manage'), ('account_manager','reports.read'), ('account_manager','reports.manage'),
    ('hr','members.manage'), ('hr','hr.read'), ('hr','hr.manage'), ('hr','hr.sensitive.read'), ('hr','reports.read'),
    ('finance','finance.read'), ('finance','finance.manage'), ('finance','hr.sensitive.read'), ('finance','reports.read'),
    ('client','work.read'), ('client','approvals.manage'), ('client','reports.read')
)
insert into public.role_capabilities (role_id, capability_id)
select organization_role.id, capability.id
from role_capability_seed seed
join public.organizations organization on organization.slug = 'magnet'
join public.organization_roles organization_role on organization_role.organization_id = organization.id and organization_role.key = seed.role_key
join public.capabilities capability on capability.key = seed.capability_key
on conflict do nothing;

with profile_roles as (
  select
    profile.id as user_id,
    case profile.role::text
      when 'Owner' then 'owner'
      when 'Admin' then 'admin'
      when 'Manager' then 'manager'
      when 'Sales' then 'sales'
      when 'Content Creator' then 'content_creator'
      when 'Designer' then 'designer'
      when 'Account Manager' then 'account_manager'
      when 'HR' then 'hr'
      when 'Finance' then 'finance'
      when 'Client' then 'client'
      else 'content_creator'
    end as role_key
  from public.profiles profile
)
insert into public.organization_members (organization_id, user_id, role_id, status, joined_at)
select organization.id, profile_role.user_id, organization_role.id, 'ACTIVE', now()
from profile_roles profile_role
join public.organizations organization on organization.slug = 'magnet'
join public.organization_roles organization_role
  on organization_role.organization_id = organization.id and organization_role.key = profile_role.role_key
on conflict (organization_id, user_id) do update
set role_id = excluded.role_id, status = 'ACTIVE', joined_at = coalesce(public.organization_members.joined_at, excluded.joined_at);

insert into public.login_aliases (user_id, alias_type, alias_value, is_primary, status, source)
select profile.id, 'EMAIL', profile.email_normalized, true, 'ACTIVE', 'LEGACY_PROFILE'
from public.profiles profile
on conflict (alias_type, alias_normalized) do update
set user_id = excluded.user_id, is_primary = true, status = 'ACTIVE', updated_at = now();

insert into public.login_aliases (user_id, alias_type, alias_value, is_primary, status, source)
select profile.id, 'USERNAME', profile.username, true, 'ACTIVE', 'LEGACY_PROFILE'
from public.profiles profile
where profile.username is not null and btrim(profile.username) <> ''
on conflict (alias_type, alias_normalized) do update
set user_id = excluded.user_id, is_primary = true, status = 'ACTIVE', updated_at = now();

insert into public.legacy_identity_links (
  legacy_account_row_id, auth_user_id, employee_record_id, link_status, evidence, reviewed_at
)
select
  account.id,
  profile.id,
  nullif(account.data->>'employeeId', ''),
  'CONFIRMED',
  jsonb_build_object('method', 'normalized_email', 'source', 'staging_reconciliation'),
  now()
from public.records account
join public.profiles profile on profile.email_normalized = lower(btrim(account.data->>'email'))
where account.coll = '_accounts'
on conflict (legacy_account_row_id) do update
set
  auth_user_id = excluded.auth_user_id,
  employee_record_id = excluded.employee_record_id,
  link_status = 'CONFIRMED',
  evidence = excluded.evidence,
  reviewed_at = excluded.reviewed_at,
  updated_at = now();

insert into public.audit_events (organization_id, action, entity_type, entity_id, safe_context)
select organization.id, 'identity.staging_reconciled', 'organization', organization.id::text,
       jsonb_build_object('source', 'm1_staging_reconciliation')
from public.organizations organization
where organization.slug = 'magnet'
  and not exists (
    select 1 from public.audit_events event
    where event.organization_id = organization.id and event.action = 'identity.staging_reconciled'
  );

__FINALIZE__;
`;

function main() {
  const args = parseArgs(process.argv);
  const projectRef = String(args['project-ref'] || '').trim();
  const apply = args.apply === true;
  if (!/^[a-z]{20}$/.test(projectRef) || projectRef === PRODUCTION_REF) {
    throw new Error('Refused: an explicit non-Production Supabase project ref is required.');
  }
  const projects = parseJsonOutput(runSupabase(['projects', 'list', '--output', 'json']));
  const project = projects.find((candidate) => candidate.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not the healthy MAGNET OS STAGING project.');
  }

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetos-identity-reconcile-'));
  fs.chmodSync(temporaryDir, 0o700);
  const temporaryFile = path.join(temporaryDir, 'reconcile.sql');
  try {
    fs.writeFileSync(temporaryFile, RECONCILIATION_SQL.replace('__FINALIZE__', apply ? 'commit' : 'rollback'), { mode: 0o600 });
    runSupabase([
      'db', 'query', '--linked', '--project-ref', projectRef,
      '--file', temporaryFile, '--output', 'json',
    ]);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }

  const rows = query(projectRef, `
    select
      (select count(*)::int from public.organizations where slug='magnet') as organizations,
      (select count(*)::int from public.organization_roles role join public.organizations organization on organization.id=role.organization_id where organization.slug='magnet') as roles,
      (select count(*)::int from public.organization_members membership join public.organizations organization on organization.id=membership.organization_id where organization.slug='magnet') as memberships,
      (select count(*)::int from public.login_aliases where status='ACTIVE') as aliases,
      (select count(*)::int from public.legacy_identity_links where link_status='CONFIRMED') as confirmed_legacy_links,
      (select count(*)::int from auth.users where coalesce(raw_app_meta_data->>'staging_placeholder','false')='true') as remaining_placeholders,
      (select count(*)::int from auth.identities identity join public.profiles profile on profile.id=identity.user_id where identity.provider='email') as profile_email_identities,
      (select count(*)::int
       from auth.users auth_user
       join public.legacy_identity_links legacy_link on legacy_link.auth_user_id=auth_user.id and legacy_link.link_status='CONFIRMED'
       where nullif(auth_user.encrypted_password,'') is null
         and (auth_user.confirmation_token is null or auth_user.recovery_token is null
           or auth_user.email_change_token_new is null or auth_user.email_change is null)) as unrepaired_passwordless_users
  `)[0] || {};

  process.stdout.write(`${apply ? 'APPLIED' : 'DRY RUN PASS'}: ${EXPECTED_STAGING_NAME} identity reconciliation.\n`);
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAILED: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}
