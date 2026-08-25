-- MAGNET OS V2 / M3: organization settings become server-authoritative.
--
-- The legacy application stored attendance, reporting, payroll, currency, and
-- module settings in each browser. Different devices could therefore operate
-- with different company rules. This additive migration introduces one
-- versioned tenant-scoped source of truth, restricted update commands, and an
-- append-only audit event without storing secret material.

begin;

create table if not exists public.organization_settings (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  settings jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(settings) = 'object'),
  check (octet_length(settings::text) <= 131072)
);

drop trigger if exists organization_settings_set_updated_at on public.organization_settings;
create trigger organization_settings_set_updated_at
  before update on public.organization_settings
  for each row execute function public.set_saas_updated_at();

insert into public.organization_settings (organization_id, settings)
select organization.id, jsonb_build_object(
  'currency', 'EGP',
  'emailNotifications', true,
  'workStartTime', '10:00',
  'workEndTime', '18:00',
  'lateGraceMinutes', 15,
  'workDaysPerMonth', 26,
  'weekendDays', 'Fri,Sat',
  'annualLeaveDefault', 21,
  'sickLeaveDefault', 6,
  'publicHolidays', '[]'::jsonb,
  'employeeReportsAuto', true,
  'employeeReportLanguage', 'English'
)
from public.organizations organization
where organization.deleted_at is null
on conflict (organization_id) do nothing;

alter table public.organization_settings enable row level security;
revoke all privileges on public.organization_settings from public, anon, authenticated;
grant select on public.organization_settings to authenticated;
grant select, insert, update, delete on public.organization_settings to service_role;

drop policy if exists organization_settings_member_read on public.organization_settings;
create policy organization_settings_member_read on public.organization_settings
  for select to authenticated
  using (public.is_active_org_member(organization_id));

create or replace function public.validate_organization_settings_patch(p_patch jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  unknown_key text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'settings patch must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p_patch::text) > 65536 then
    raise exception 'settings patch is too large' using errcode = '22023';
  end if;

  select key into unknown_key
  from jsonb_object_keys(p_patch) key
  where key <> all (array[
    'currency','emailNotifications','enabledModules','requireVerification',
    'partners','payroll','payrollBasis','workStartTime','workEndTime',
    'lateGraceMinutes','workDaysPerMonth','weekendDays',
    'annualLeaveDefault','sickLeaveDefault','publicHolidays',
    'employeeReportsAuto','employeeReportLanguage','employeeReportAutoSkipped'
  ])
  limit 1;
  if unknown_key is not null then
    raise exception 'unsupported organization setting: %', unknown_key using errcode = '22023';
  end if;

  if p_patch ? 'currency' and (jsonb_typeof(p_patch->'currency') <> 'string'
    or p_patch->>'currency' not in ('EGP','USD','SAR','AED','EUR','KWD')) then
    raise exception 'invalid currency' using errcode = '22023';
  end if;
  if p_patch ? 'emailNotifications' and jsonb_typeof(p_patch->'emailNotifications') <> 'boolean' then
    raise exception 'invalid emailNotifications value' using errcode = '22023';
  end if;
  if p_patch ? 'requireVerification' and jsonb_typeof(p_patch->'requireVerification') <> 'boolean' then
    raise exception 'invalid requireVerification value' using errcode = '22023';
  end if;
  if p_patch ? 'employeeReportsAuto' and jsonb_typeof(p_patch->'employeeReportsAuto') <> 'boolean' then
    raise exception 'invalid employeeReportsAuto value' using errcode = '22023';
  end if;
  if p_patch ? 'employeeReportLanguage' and (jsonb_typeof(p_patch->'employeeReportLanguage') <> 'string'
    or p_patch->>'employeeReportLanguage' not in ('Arabic','English')) then
    raise exception 'invalid employee report language' using errcode = '22023';
  end if;
  if p_patch ? 'workStartTime' and (jsonb_typeof(p_patch->'workStartTime') <> 'string'
    or p_patch->>'workStartTime' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'invalid work start time' using errcode = '22023';
  end if;
  if p_patch ? 'workEndTime' and (jsonb_typeof(p_patch->'workEndTime') <> 'string'
    or p_patch->>'workEndTime' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'invalid work end time' using errcode = '22023';
  end if;
  if p_patch ? 'lateGraceMinutes' and (jsonb_typeof(p_patch->'lateGraceMinutes') <> 'number'
    or (p_patch->>'lateGraceMinutes')::numeric < 0 or (p_patch->>'lateGraceMinutes')::numeric > 240) then
    raise exception 'invalid late grace minutes' using errcode = '22023';
  end if;
  if p_patch ? 'workDaysPerMonth' and (jsonb_typeof(p_patch->'workDaysPerMonth') <> 'number'
    or (p_patch->>'workDaysPerMonth')::numeric < 1 or (p_patch->>'workDaysPerMonth')::numeric > 31) then
    raise exception 'invalid work days per month' using errcode = '22023';
  end if;
  if p_patch ? 'annualLeaveDefault' and (jsonb_typeof(p_patch->'annualLeaveDefault') <> 'number'
    or (p_patch->>'annualLeaveDefault')::numeric < 0 or (p_patch->>'annualLeaveDefault')::numeric > 365) then
    raise exception 'invalid annual leave allowance' using errcode = '22023';
  end if;
  if p_patch ? 'sickLeaveDefault' and (jsonb_typeof(p_patch->'sickLeaveDefault') <> 'number'
    or (p_patch->>'sickLeaveDefault')::numeric < 0 or (p_patch->>'sickLeaveDefault')::numeric > 365) then
    raise exception 'invalid sick leave allowance' using errcode = '22023';
  end if;
  if p_patch ? 'weekendDays' and (jsonb_typeof(p_patch->'weekendDays') <> 'string'
    or char_length(p_patch->>'weekendDays') > 80) then
    raise exception 'invalid weekend days' using errcode = '22023';
  end if;
  if p_patch ? 'payrollBasis' and (jsonb_typeof(p_patch->'payrollBasis') <> 'string'
    or p_patch->>'payrollBasis' not in ('work','calendar')) then
    raise exception 'invalid payroll basis' using errcode = '22023';
  end if;
  if p_patch ? 'payroll' and (jsonb_typeof(p_patch->'payroll') <> 'object'
    or octet_length((p_patch->'payroll')::text) > 32768) then
    raise exception 'invalid payroll settings' using errcode = '22023';
  end if;
  if p_patch ? 'publicHolidays' and (jsonb_typeof(p_patch->'publicHolidays') <> 'array'
    or jsonb_array_length(p_patch->'publicHolidays') > 366) then
    raise exception 'invalid public holidays' using errcode = '22023';
  end if;
  if p_patch ? 'employeeReportAutoSkipped' and (jsonb_typeof(p_patch->'employeeReportAutoSkipped') <> 'array'
    or jsonb_array_length(p_patch->'employeeReportAutoSkipped') > 500) then
    raise exception 'invalid report automation state' using errcode = '22023';
  end if;
  if p_patch ? 'enabledModules' and p_patch->'enabledModules' <> 'null'::jsonb
    and (jsonb_typeof(p_patch->'enabledModules') <> 'array'
      or jsonb_array_length(p_patch->'enabledModules') > 100) then
    raise exception 'invalid enabled modules' using errcode = '22023';
  end if;
  if p_patch ? 'partners' and (jsonb_typeof(p_patch->'partners') <> 'array'
    or jsonb_array_length(p_patch->'partners') > 100) then
    raise exception 'invalid partner settings' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.validate_organization_settings_patch(jsonb) from public, anon, authenticated;

create or replace function public.update_organization_settings(
  p_organization_id uuid,
  p_patch jsonb,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.organization_settings%rowtype;
  requested_keys text[];
  actor_can_organization boolean;
  actor_can_hr boolean;
  actor_can_finance boolean;
  actor_can_reports boolean;
begin
  if not public.is_active_org_member(p_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  perform public.validate_organization_settings_patch(p_patch);

  select coalesce(array_agg(key order by key), '{}'::text[]) into requested_keys
  from jsonb_object_keys(p_patch) key;

  actor_can_organization := public.has_org_capability(p_organization_id, 'organization.manage');
  actor_can_hr := public.has_org_capability(p_organization_id, 'hr.manage');
  actor_can_finance := public.has_org_capability(p_organization_id, 'finance.manage');
  actor_can_reports := public.has_org_capability(p_organization_id, 'reports.manage');

  if requested_keys && array['currency','emailNotifications','enabledModules','requireVerification']::text[]
    and not actor_can_organization then
    raise exception 'organization settings update is not authorized' using errcode = '42501';
  end if;
  if requested_keys && array['workStartTime','workEndTime','lateGraceMinutes','weekendDays',
    'annualLeaveDefault','sickLeaveDefault','publicHolidays']::text[]
    and not (actor_can_organization or actor_can_hr) then
    raise exception 'HR settings update is not authorized' using errcode = '42501';
  end if;
  if requested_keys && array['partners','payroll','payrollBasis']::text[]
    and not (actor_can_organization or actor_can_finance) then
    raise exception 'finance settings update is not authorized' using errcode = '42501';
  end if;
  if requested_keys && array['workDaysPerMonth']::text[]
    and not (actor_can_organization or actor_can_hr or actor_can_finance) then
    raise exception 'work calendar settings update is not authorized' using errcode = '42501';
  end if;
  if requested_keys && array['employeeReportsAuto','employeeReportLanguage','employeeReportAutoSkipped']::text[]
    and not (actor_can_organization or actor_can_hr or actor_can_reports) then
    raise exception 'report settings update is not authorized' using errcode = '42501';
  end if;

  insert into public.organization_settings (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select * into current_row
  from public.organization_settings organization_setting
  where organization_setting.organization_id = p_organization_id
  for update;

  if p_expected_version is not null and current_row.version <> p_expected_version then
    raise exception 'organization settings version conflict' using errcode = '40001';
  end if;

  update public.organization_settings organization_setting
  set
    settings = organization_setting.settings || p_patch,
    version = organization_setting.version + 1,
    updated_by = auth.uid()
  where organization_setting.organization_id = p_organization_id
  returning * into current_row;

  insert into public.audit_events (
    organization_id, actor_user_id, action, entity_type, entity_id, safe_context
  ) values (
    p_organization_id,
    auth.uid(),
    'organization.settings_updated',
    'organization_settings',
    p_organization_id::text,
    jsonb_build_object('keys', to_jsonb(requested_keys), 'version', current_row.version)
  );

  return jsonb_build_object(
    'settings', current_row.settings,
    'version', current_row.version,
    'updatedAt', current_row.updated_at
  );
end;
$$;

revoke all on function public.update_organization_settings(uuid, jsonb, bigint) from public, anon;
grant execute on function public.update_organization_settings(uuid, jsonb, bigint) to authenticated;

insert into public.migration_audit (migration, note)
values (
  '20260825183000_organization_settings_source_of_truth',
  'Added versioned tenant-scoped organization settings, member reads, capability-scoped validated updates, and append-only audit events. No production application or database was changed.'
);

commit;

-- Rollback is forward-only: point the application back to local defaults, revoke
-- update_organization_settings from authenticated, and retain the table/audit
-- history until a separately reviewed cleanup migration is approved.
