-- MAGNET OS V2 / M2 follow-up: recoverable deletes and bounded log retention.
--
-- Browser roles never receive DELETE on `records`. Business deletes become
-- audited tombstones, while only two explicitly ephemeral collections may be
-- physically pruned by an authorized organization administrator.

begin;

create or replace function public.soft_delete_record(
  p_organization_id uuid,
  p_record_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.records%rowtype;
  deleted_at timestamptz := now();
begin
  select * into target
  from public.records record
  where record.organization_id = p_organization_id
    and record.id = p_record_id
  for update;

  if target.id is null then return false; end if;
  if not public.records_can_write(target.organization_id, target.coll, target.data) then
    raise exception 'record delete is not authorized' using errcode = '42501';
  end if;
  if target.deleted_at is not null or coalesce(target.data->>'_del', '') = 'true' then
    return true;
  end if;

  update public.records
  set data = target.data || jsonb_build_object(
    '_del', true,
    'updatedAt', deleted_at,
    'updatedBy', auth.uid()::text
  )
  where organization_id = p_organization_id
    and id = p_record_id;

  insert into public.audit_events (
    organization_id, actor_user_id, action, entity_type, entity_id, safe_context
  ) values (
    p_organization_id,
    auth.uid(),
    'record.soft_delete',
    target.coll,
    target.id,
    jsonb_build_object('collection', target.coll)
  );

  return true;
end;
$$;

revoke all on function public.soft_delete_record(uuid, text) from public, anon;
grant execute on function public.soft_delete_record(uuid, text) to authenticated;

-- Tombstones are server-visible for audit/recovery but disappear from every
-- browser read and cannot be restored with an ordinary PATCH.
drop policy if exists records_authenticated_select on public.records;
drop policy if exists records_authenticated_insert on public.records;
drop policy if exists records_authenticated_update on public.records;

create policy records_authenticated_select on public.records
  for select to authenticated
  using (
    deleted_at is null
    and public.records_can_read(organization_id, coll, data)
  );

create policy records_authenticated_insert on public.records
  for insert to authenticated
  with check (
    deleted_at is null
    and public.records_can_write(organization_id, coll, data)
  );

create policy records_authenticated_update on public.records
  for update to authenticated
  using (
    deleted_at is null
    and public.records_can_write(organization_id, coll, data)
  )
  with check (
    deleted_at is null
    and public.records_can_write(organization_id, coll, data)
  );

create or replace function public.prune_ephemeral_records(
  p_organization_id uuid,
  p_collection text,
  p_keep integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer := 0;
begin
  if p_collection not in ('activityLogs', 'notifications') then
    raise exception 'collection is not eligible for pruning' using errcode = '22023';
  end if;
  if p_keep < 50 or p_keep > 5000 then
    raise exception 'invalid retention count' using errcode = '22023';
  end if;
  if not public.has_org_capability(p_organization_id, 'members.manage') then
    raise exception 'record pruning is not authorized' using errcode = '42501';
  end if;

  with ranked as (
    select
      record.id,
      row_number() over (
        order by coalesce(
          public.try_ts(record.data->>'createdAt'),
          record.created_at,
          record.updated_at
        ) desc, record.id desc
      ) as position
    from public.records record
    where record.organization_id = p_organization_id
      and record.coll = p_collection
  ), removed as (
    delete from public.records record
    using ranked
    where record.organization_id = p_organization_id
      and record.id = ranked.id
      and ranked.position > p_keep
    returning record.id
  )
  select count(*) into deleted_count from removed;

  if deleted_count > 0 then
    insert into public.audit_events (
      organization_id, actor_user_id, action, entity_type, safe_context
    ) values (
      p_organization_id,
      auth.uid(),
      'records.retention_prune',
      p_collection,
      jsonb_build_object('collection', p_collection, 'removedCount', deleted_count, 'retainedCount', p_keep)
    );
  end if;

  return deleted_count;
end;
$$;

revoke all on function public.prune_ephemeral_records(uuid, text, integer) from public, anon;
grant execute on function public.prune_ephemeral_records(uuid, text, integer) to authenticated;

insert into public.migration_audit (migration, note)
values (
  '20260825174200_record_soft_delete_command',
  'Added an authorized audited soft-delete command, hid tombstones from browser RLS, blocked ordinary restore patches, and added bounded administrator-only retention for activityLogs and notifications.'
);

commit;

-- Rollback is forward-only: revoke the RPCs from authenticated and replace the
-- browser paths before removing either function.
