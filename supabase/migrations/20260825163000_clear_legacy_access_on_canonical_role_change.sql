-- MAGNET OS V2 / M1.9 — clear stale legacy access when canonical role changes.
--
-- A legacy account may already display the target role while still carrying
-- per-module overrides from its previous canonical membership. An AFTER UPDATE
-- trigger uses OLD/NEW membership role ids, not the stale label, so overrides are
-- reliably removed whenever the authoritative role changes.

begin;

create or replace function public.sync_confirmed_legacy_account_from_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  role_key text;
  legacy_role text;
  legacy_status text;
  linked_legacy_row_id text;
begin
  select organization_role.key into role_key
  from public.organization_roles organization_role
  where organization_role.id = new.role_id
    and organization_role.organization_id = new.organization_id;

  legacy_role := case role_key
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
  legacy_status := case when new.status = 'ACTIVE' then 'Active' else 'Inactive' end;

  select link.legacy_account_row_id into linked_legacy_row_id
  from public.legacy_identity_links link
  where link.auth_user_id = new.user_id
    and link.link_status = 'CONFIRMED'
  limit 1;

  if linked_legacy_row_id is not null then
    update public.records legacy_account
    set data = legacy_account.data || jsonb_build_object(
      'role', legacy_role,
      'status', legacy_status,
      'access', case
        when old.role_id is distinct from new.role_id then '{}'::jsonb
        else coalesce(legacy_account.data->'access', '{}'::jsonb)
      end
    )
    where legacy_account.id = linked_legacy_row_id
      and legacy_account.coll = '_accounts';
  end if;

  return new;
end;
$$;

revoke all on function public.sync_confirmed_legacy_account_from_membership() from public, anon, authenticated;

drop trigger if exists organization_members_sync_confirmed_legacy_account on public.organization_members;
create trigger organization_members_sync_confirmed_legacy_account
after update of role_id, status on public.organization_members
for each row
when (old.role_id is distinct from new.role_id or old.status is distinct from new.status)
execute function public.sync_confirmed_legacy_account_from_membership();

insert into public.migration_audit (migration, note)
select
  '20260825163000_clear_legacy_access_on_canonical_role_change',
  'Added a membership trigger that synchronizes confirmed legacy accounts and clears stale module overrides whenever the canonical role changes.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825163000_clear_legacy_access_on_canonical_role_change'
);

commit;

-- Rollback: drop the trigger in a new forward migration. The function is
-- non-destructive and affects only confirmed cutover links.
