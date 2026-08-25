-- Follow-up to 20260825174200: avoid a PL/pgSQL variable name that collides
-- with the records.deleted_at column while RLS policies are evaluated.

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
  deletion_time timestamptz := now();
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
    'updatedAt', deletion_time,
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

insert into public.migration_audit (migration, note)
values (
  '20260825174800_fix_soft_delete_ambiguity',
  'Renamed the soft-delete timestamp variable to avoid collision with records.deleted_at during RLS evaluation.'
);

commit;

-- Rollback is forward-only: replace the function with the last validated body.
