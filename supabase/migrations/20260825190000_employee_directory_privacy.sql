-- MAGNET OS V2 / M3: protect employee private and compensation data.
--
-- Employee profiles still live in legacy JSON records during the controlled
-- monolith migration. RLS cannot redact individual JSON keys, so full employee
-- rows are now limited to the employee themself and roles with the explicit
-- hr.sensitive.read capability. Every active member can use a separate
-- read-only, sanitized directory RPC for assignment/team UI.

begin;

create or replace function public.record_matches_current_user(p_data jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with identity_refs as (
    select auth.uid()::text as ref
    union
    select nullif(profile.employee_id, '')
    from public.profiles profile
    where profile.id = auth.uid()
    union
    select nullif(identity_link.employee_record_id, '')
    from public.legacy_identity_links identity_link
    where identity_link.auth_user_id = auth.uid()
      and identity_link.link_status = 'CONFIRMED'
    union
    select identity_link.legacy_account_row_id
    from public.legacy_identity_links identity_link
    where identity_link.auth_user_id = auth.uid()
      and identity_link.link_status = 'CONFIRMED'
  )
  select exists (
    select 1
    from identity_refs
    where ref is not null
      and ref <> ''
      and ref = any (array[
        p_data->>'id', p_data->>'userId', p_data->>'employeeId', p_data->>'assignedTo',
        p_data->>'requestedBy', p_data->>'createdBy', p_data->>'ownerId',
        p_data->>'authorId', p_data->>'senderId', p_data->>'reviewerId'
      ])
  );
$$;

revoke all on function public.record_matches_current_user(jsonb) from public, anon;
grant execute on function public.record_matches_current_user(jsonb) to authenticated;

create or replace function public.records_can_read(
  p_organization_id uuid,
  p_collection text,
  p_data jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  member_role text;
begin
  if not public.is_active_org_member(p_organization_id) then return false; end if;
  if p_collection in ('_accounts', '_ratelimit', '_config') then return false; end if;

  member_role := public.current_member_role_key(p_organization_id);

  if p_collection = any (array[
    'clients','leads','contacts','salesActivities','proposals','quotations',
    'contracts','campaigns','briefs','packages','renewals'
  ]) then
    if not public.has_org_capability(p_organization_id, 'clients.read') then return false; end if;
    return member_role <> 'client' or public.record_matches_current_client(p_data);
  end if;

  if p_collection = any (array[
    'projects','tasks','deliverables','clientAssets','chatMessages','comments',
    'files','revisions','meetings','plans'
  ]) then
    if not public.has_org_capability(p_organization_id, 'work.read') then return false; end if;
    return member_role <> 'client' or public.record_matches_current_client(p_data);
  end if;

  if p_collection = 'approvalRequests' then
    return public.has_org_capability(p_organization_id, 'approvals.manage')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = 'employees' then
    return public.has_org_capability(p_organization_id, 'hr.sensitive.read')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = any (array['attendance','leaves','performanceReviews']) then
    return public.has_org_capability(p_organization_id, 'hr.read')
      or public.has_org_capability(p_organization_id, 'hr.sensitive.read')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = any (array['candidates','freelancers']) then
    return public.has_org_capability(p_organization_id, 'hr.read');
  end if;

  if p_collection = any (array[
    'invoices','payments','expenses','fixedCosts','partnerSettlements','collections'
  ]) then
    if not public.has_org_capability(p_organization_id, 'finance.read') then return false; end if;
    return member_role <> 'client' or public.record_matches_current_client(p_data);
  end if;

  if p_collection = 'employeePayments' then
    return public.has_org_capability(p_organization_id, 'finance.read')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = 'reports' then
    if not public.has_org_capability(p_organization_id, 'reports.read') then return false; end if;
    if member_role = 'client' then return public.record_matches_current_client(p_data); end if;
    return true;
  end if;

  if p_collection = 'activityLogs' then
    return public.has_org_capability(p_organization_id, 'audit.read')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = 'notifications' then
    return public.record_matches_current_user(p_data)
      or public.has_org_capability(p_organization_id, 'members.manage');
  end if;

  if p_collection = any (array['gameScores','gameStats','departments','services']) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.records_can_read(uuid, text, jsonb) from public, anon;
grant execute on function public.records_can_read(uuid, text, jsonb) to authenticated;

create or replace function public.employee_directory(
  p_organization_id uuid,
  p_since timestamptz default null
)
returns table (
  id text,
  data jsonb,
  updated_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_active_org_member(p_organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  return query
  select
    record.id,
    case when record.deleted_at is not null then
      jsonb_build_object('id', record.id, '_del', true, '_directoryOnly', true)
    else
      jsonb_strip_nulls(jsonb_build_object(
        'id', record.id,
        'fullName', record.data->'fullName',
        'displayName', record.data->'displayName',
        'employeeCode', record.data->'employeeCode',
        'jobTitle', record.data->'jobTitle',
        'departmentId', record.data->'departmentId',
        'employmentType', record.data->'employmentType',
        'status', record.data->'status',
        'workMode', record.data->'workMode',
        'managerId', record.data->'managerId',
        'capacityPerWeek', record.data->'capacityPerWeek',
        'skills', record.data->'skills',
        'appRole', record.data->'appRole',
        'createdAt', record.data->'createdAt',
        'updatedAt', record.data->'updatedAt',
        '_directoryOnly', true
      ))
    end,
    record.updated_at,
    record.deleted_at
  from public.records record
  where record.organization_id = p_organization_id
    and record.coll = 'employees'
    and (p_since is null or record.updated_at > p_since)
  order by record.updated_at, record.id;
end;
$$;

revoke all on function public.employee_directory(uuid, timestamptz) from public, anon;
grant execute on function public.employee_directory(uuid, timestamptz) to authenticated;

insert into public.migration_audit (migration, note)
values (
  '20260825190000_employee_directory_privacy',
  'Restricted full employee JSON to self or hr.sensitive.read and added an authenticated tenant-scoped sanitized employee directory with delta support. No production application or database was changed.'
);

commit;

-- Rollback is forward-only: retain the privacy boundary and adjust the directory
-- allowlist or capability grants through a separately reviewed migration.
