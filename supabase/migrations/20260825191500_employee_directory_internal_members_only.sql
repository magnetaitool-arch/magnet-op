-- MAGNET OS V2 / M3.1: the staff directory is internal-only.
--
-- The preceding privacy migration removed private employee fields, but an
-- active client membership must still never enumerate the agency team. This
-- append-only follow-up keeps the sanitized directory available to staff while
-- failing closed for client portal identities.

begin;

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

  if public.current_member_role_key(p_organization_id) = 'client' then
    raise exception 'employee directory is internal only' using errcode = '42501';
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
  '20260825191500_employee_directory_internal_members_only',
  'Restricted the sanitized employee directory to internal organization members; client portal identities fail closed. No production application or database was changed.'
);

commit;

-- Rollback is forward-only: preserve the internal-only boundary and adjust
-- explicit staff role access in a separately reviewed migration if required.
