-- MAGNET OS V2 / M1.7 — one authoritative role command during legacy cutover.
--
-- The canonical organization membership is authoritative. While the legacy UI
-- still reads `_accounts`, update its role/status in the SAME transaction so an
-- administrator cannot successfully change one identity model and leave the
-- other model stale. This bridge is removed only after the legacy shell stops
-- consuming `_accounts` role values.

begin;

create or replace function public.identity_update_membership(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_target_user_id uuid,
  p_role_key text,
  p_status text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_membership public.organization_members%rowtype;
  target_role public.organization_roles%rowtype;
  current_role_key text;
  active_owner_count integer;
  next_epoch integer;
  legacy_role text;
  legacy_status text;
  linked_legacy_row_id text;
  legacy_rows_updated integer := 0;
begin
  if p_actor_user_id is null or (p_actor_user_id <> auth.uid() and auth.role() <> 'service_role') then
    raise exception 'identity_actor_mismatch' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_members actor_membership
    join public.profiles actor_profile on actor_profile.id = actor_membership.user_id
    join public.organizations organization on organization.id = actor_membership.organization_id
    join public.organization_roles actor_role on actor_role.id = actor_membership.role_id
      and actor_role.organization_id = actor_membership.organization_id
    join public.role_capabilities role_capability on role_capability.role_id = actor_role.id
    join public.capabilities capability on capability.id = role_capability.capability_id
    where actor_membership.organization_id = p_organization_id
      and actor_membership.user_id = p_actor_user_id
      and actor_membership.status = 'ACTIVE'
      and actor_profile.identity_status = 'ACTIVE'
      and organization.status = 'ACTIVE'
      and organization.deleted_at is null
      and capability.key = 'members.manage'
  ) then
    raise exception 'identity_forbidden' using errcode = '42501';
  end if;

  if upper(btrim(p_status)) not in ('ACTIVE','SUSPENDED','DISABLED','ARCHIVED') then
    raise exception 'identity_invalid_status' using errcode = '22023';
  end if;

  select * into target_role
  from public.organization_roles organization_role
  where organization_role.organization_id = p_organization_id
    and organization_role.key = lower(btrim(p_role_key));
  if not found then raise exception 'identity_role_not_found' using errcode = 'P0002'; end if;

  select * into target_membership
  from public.organization_members membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_target_user_id
  for update;
  if not found then raise exception 'identity_membership_not_found' using errcode = 'P0002'; end if;

  select organization_role.key into current_role_key
  from public.organization_roles organization_role
  where organization_role.id = target_membership.role_id;

  if current_role_key = 'owner' and (target_role.key <> 'owner' or upper(btrim(p_status)) <> 'ACTIVE') then
    select count(*)::integer into active_owner_count
    from public.organization_members membership
    join public.organization_roles organization_role on organization_role.id = membership.role_id
    where membership.organization_id = p_organization_id
      and organization_role.key = 'owner'
      and membership.status = 'ACTIVE';
    if active_owner_count <= 1 then raise exception 'identity_last_owner' using errcode = '23514'; end if;
  end if;

  update public.organization_members
  set role_id = target_role.id,
      status = upper(btrim(p_status)),
      archived_at = case when upper(btrim(p_status)) = 'ARCHIVED' then coalesce(archived_at, now()) else null end
  where id = target_membership.id;

  update public.profiles
  set session_epoch = session_epoch + 1
  where id = p_target_user_id
  returning session_epoch into next_epoch;

  legacy_role := case target_role.key
    when 'owner' then 'Owner'
    when 'admin' then 'Admin'
    when 'manager' then 'Manager'
    when 'sales' then 'Sales'
    when 'content_creator' then 'Content Creator'
    when 'designer' then 'Designer'
    when 'account_manager' then 'Account Manager'
    when 'hr' then 'HR'
    when 'finance' then 'Finance'
    when 'client' then 'Client'
    else 'Viewer'
  end;
  legacy_status := case when upper(btrim(p_status)) = 'ACTIVE' then 'Active' else 'Inactive' end;

  select link.legacy_account_row_id into linked_legacy_row_id
  from public.legacy_identity_links link
  where link.auth_user_id = p_target_user_id
    and link.link_status = 'CONFIRMED'
  limit 1;

  if linked_legacy_row_id is not null then
    update public.records legacy_account
    set data = legacy_account.data || jsonb_build_object(
      'role', legacy_role,
      'status', legacy_status,
      'access', case
        when coalesce(legacy_account.data->>'role', '') = legacy_role
          then coalesce(legacy_account.data->'access', '{}'::jsonb)
        else '{}'::jsonb
      end
    )
    where legacy_account.id = linked_legacy_row_id
      and legacy_account.coll = '_accounts';
    get diagnostics legacy_rows_updated = row_count;
  end if;

  insert into public.audit_events (
    request_id, organization_id, actor_user_id, action, entity_type, entity_id, after_data, safe_context
  ) values (
    coalesce(p_request_id, gen_random_uuid()), p_organization_id, p_actor_user_id,
    'membership.updated', 'organization_member', target_membership.id::text,
    jsonb_build_object(
      'roleKey', target_role.key,
      'status', upper(btrim(p_status)),
      'sessionEpoch', next_epoch,
      'legacyCompatibilityRows', legacy_rows_updated
    ),
    jsonb_build_object('source', 'identity_command')
  );

  return jsonb_build_object(
    'ok', true,
    'membershipId', target_membership.id,
    'sessionEpoch', next_epoch,
    'legacyCompatibilityRows', legacy_rows_updated
  );
end;
$$;

revoke all on function public.identity_update_membership(uuid,uuid,uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.identity_update_membership(uuid,uuid,uuid,text,text,uuid) to service_role;

insert into public.migration_audit (migration, note)
select
  '20260825153000_sync_legacy_role_from_identity_command',
  'Made canonical membership role/status authoritative and synchronized a confirmed legacy account in the same transaction during cutover.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825153000_sync_legacy_role_from_identity_command'
);

commit;

-- Rollback: replace identity_update_membership with the prior implementation in
-- a new forward migration. Do not edit or remove this applied migration.
