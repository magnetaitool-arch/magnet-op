#!/usr/bin/env node
'use strict';

// Repairs only unambiguous, one-to-one legacy account ↔ employee links in
// MAGNET OS STAGING. The command is a rollback-only dry run unless --apply is
// supplied. It never creates identities, changes passwords, or targets Prod.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
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

const ROLE_KEY_SQL = (column) => `case lower(btrim(coalesce(${column}, '')))
  when 'owner' then 'owner'
  when 'admin' then 'admin'
  when 'manager' then 'manager'
  when 'project manager' then 'manager'
  when 'account manager' then 'account_manager'
  when 'sales' then 'sales'
  when 'hr' then 'hr'
  when 'finance' then 'finance'
  when 'accountant' then 'finance'
  when 'designer' then 'designer'
  when 'graphic designer' then 'designer'
  when 'content' then 'content_creator'
  when 'content creator' then 'content_creator'
  when 'video editor' then 'content_creator'
  when 'production' then 'content_creator'
  when 'client' then 'client'
  else null end`;

const ACTIVE_ACCOUNT = "coll='_accounts' and lower(coalesce(data->>'_del','false')) not in ('true','1','t')";
const ACTIVE_EMPLOYEE = "coll='employees' and lower(coalesce(data->>'_del','false')) not in ('true','1','t')";

function repairSql(apply) {
  return String.raw`
begin;

do $$
begin
  if to_regclass('public.records') is null
     or to_regclass('public.legacy_identity_links') is null
     or to_regclass('public.audit_events') is null then
    raise exception 'required identity tables are missing';
  end if;
  if exists (
    select 1 from public.records
    where ${ACTIVE_ACCOUNT}
      and nullif(btrim(data->>'id'), '') is not null
    group by data->>'id' having count(*) > 1
  ) then
    raise exception 'duplicate active legacy account ids';
  end if;
end $$;

create temporary table safe_legacy_link_repairs on commit drop as
with active_accounts as (
  select id as account_row_id, data as account_data,
         lower(btrim(data->>'email')) as email_normalized
  from public.records where ${ACTIVE_ACCOUNT}
),
active_employees as (
  select id as employee_row_id, data as employee_data,
         lower(btrim(coalesce(nullif(data->>'loginEmail',''), data->>'email'))) as email_normalized
  from public.records where ${ACTIVE_EMPLOYEE}
),
unique_accounts as (
  select email_normalized, min(account_row_id) as account_row_id
  from active_accounts where nullif(email_normalized,'') is not null
  group by email_normalized having count(*) = 1
),
unique_employees as (
  select email_normalized, min(employee_row_id) as employee_row_id
  from active_employees where nullif(email_normalized,'') is not null
  group by email_normalized having count(*) = 1
),
pairs as (
  select account.account_row_id, employee.employee_row_id,
         account.account_data, employee.employee_data,
         account.email_normalized,
         account.account_data->>'id' as account_id,
         ${ROLE_KEY_SQL("account.account_data->>'role'")} as account_role_key,
         ${ROLE_KEY_SQL("coalesce(employee.employee_data->>'appRole', employee.employee_data->>'role')")} as employee_role_key
  from unique_accounts unique_account
  join unique_employees unique_employee using (email_normalized)
  join active_accounts account on account.account_row_id = unique_account.account_row_id
  join active_employees employee on employee.employee_row_id = unique_employee.employee_row_id
)
select *,
       (account_data->>'employeeId' is distinct from employee_row_id) as repair_account,
       (employee_data->>'userId' is distinct from account_id) as repair_employee
from pairs
where nullif(btrim(account_id),'') is not null
  and account_role_key is not null
  and account_role_key = employee_role_key
  and (
    nullif(btrim(account_data->>'employeeId'),'') is null
    or not exists (
      select 1 from public.records linked_employee
      where linked_employee.id = account_data->>'employeeId' and ${ACTIVE_EMPLOYEE.replaceAll('data', 'linked_employee.data').replace("coll=", "linked_employee.coll=")}
    )
    or account_data->>'employeeId' = employee_row_id
  )
  and (
    nullif(btrim(employee_data->>'userId'),'') is null
    or not exists (
      select 1 from public.records linked_account
      where linked_account.coll='_accounts'
        and lower(coalesce(linked_account.data->>'_del','false')) not in ('true','1','t')
        and linked_account.data->>'id' = employee_data->>'userId'
    )
    or employee_data->>'userId' = account_id
  );

do $$
begin
  if exists (
    select 1 from safe_legacy_link_repairs
    group by account_row_id having count(*) > 1
  ) or exists (
    select 1 from safe_legacy_link_repairs
    group by employee_row_id having count(*) > 1
  ) then
    raise exception 'ambiguous repair set';
  end if;
end $$;

update public.records account
set data = jsonb_set(
             jsonb_set(account.data, '{employeeId}', to_jsonb(repair.employee_row_id), true),
             '{updatedAt}', to_jsonb(now()::text), true
           )
from safe_legacy_link_repairs repair
where account.id = repair.account_row_id and repair.repair_account;

update public.records employee
set data = jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(employee.data, '{userId}', to_jsonb(repair.account_id), true),
                 '{loginEmail}', to_jsonb(repair.account_data->>'email'), true
               ),
               '{accountStatus}', to_jsonb(
                 case when lower(coalesce(repair.account_data->>'status','active'))='active'
                      then 'Active'::text else 'Disabled'::text end
               ), true
             ),
             '{updatedAt}', to_jsonb(now()::text), true
           )
from safe_legacy_link_repairs repair
where employee.id = repair.employee_row_id and repair.repair_employee;

insert into public.legacy_identity_links (
  legacy_account_row_id, auth_user_id, employee_record_id,
  link_status, evidence, reviewed_at
)
select repair.account_row_id, profile.id, repair.employee_row_id,
       'CONFIRMED',
       jsonb_build_object('method','unique_normalized_email','source','staging_safe_link_repair'),
       now()
from safe_legacy_link_repairs repair
join public.profiles profile on profile.email_normalized = repair.email_normalized
where repair.repair_account or repair.repair_employee
on conflict (legacy_account_row_id) do update
set employee_record_id=excluded.employee_record_id,
    auth_user_id=excluded.auth_user_id,
    link_status='CONFIRMED', evidence=excluded.evidence,
    reviewed_at=excluded.reviewed_at, updated_at=now();

insert into public.audit_events (organization_id, action, entity_type, entity_id, safe_context)
select organization.id, 'identity.staging_legacy_links_repaired', 'organization', organization.id::text,
       jsonb_build_object(
         'source','safe_unique_normalized_email',
         'pair_count', count(*) filter (where repair_account or repair_employee)
       )
from public.organizations organization
cross join safe_legacy_link_repairs
where organization.slug='magnet'
group by organization.id
having count(*) filter (where repair_account or repair_employee) > 0;

${apply ? 'commit;' : 'rollback;'}
`;
}

function summary(projectRef) {
  return query(projectRef, `
    with active_accounts as (
      select id as account_row_id, data as account_data, lower(btrim(data->>'email')) email
      from public.records where ${ACTIVE_ACCOUNT}
    ), active_employees as (
      select id as employee_row_id, data as employee_data,
             lower(btrim(coalesce(nullif(data->>'loginEmail',''),data->>'email'))) email
      from public.records where ${ACTIVE_EMPLOYEE}
    ), ua as (
      select email,min(account_row_id) account_row_id from active_accounts
      where nullif(email,'') is not null group by email having count(*)=1
    ), ue as (
      select email,min(employee_row_id) employee_row_id from active_employees
      where nullif(email,'') is not null group by email having count(*)=1
    ), pairs as (
      select account.account_data, employee.employee_data, employee.employee_row_id
      from ua join ue using(email)
      join active_accounts account using(account_row_id)
      join active_employees employee using(employee_row_id)
      where ${ROLE_KEY_SQL("account.account_data->>'role'")} =
            ${ROLE_KEY_SQL("coalesce(employee.employee_data->>'appRole',employee.employee_data->>'role')")}
    )
    select count(*)::int as safe_pairs,
      count(*) filter(where account_data->>'employeeId' is distinct from employee_row_id)::int as broken_account_links,
      count(*) filter(where employee_data->>'userId' is distinct from account_data->>'id')::int as broken_employee_links
    from pairs
  `)[0] || {};
}

function main() {
  const args = parseArgs(process.argv);
  const projectRef = String(args['project-ref'] || '').trim();
  const apply = args.apply === true;
  if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
    throw new Error('Refused: an explicit non-Production Supabase project ref is required.');
  }
  const projects = parseJsonOutput(runSupabase(['projects', 'list', '--output', 'json']));
  const project = projects.find((candidate) => candidate.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not the healthy MAGNET OS STAGING project.');
  }

  const before = summary(projectRef);
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetos-link-repair-'));
  fs.chmodSync(temporaryDir, 0o700);
  const temporaryFile = path.join(temporaryDir, 'repair.sql');
  try {
    fs.writeFileSync(temporaryFile, repairSql(apply), { mode: 0o600 });
    runSupabase(['db','query','--linked','--project-ref',projectRef,'--file',temporaryFile,'--output','json']);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
  const after = summary(projectRef);
  process.stdout.write(`${apply ? 'APPLIED' : 'DRY RUN PASS'}: ${EXPECTED_STAGING_NAME} legacy link repair.\n`);
  process.stdout.write(`${JSON.stringify({ before, after })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAILED: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}
