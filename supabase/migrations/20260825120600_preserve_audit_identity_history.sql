-- MAGNET OS V2 / M1.6 — keep audit/auth event identities immutable.
--
-- ON DELETE SET NULL conflicts with the append-only update trigger. Event rows
-- intentionally retain historical UUIDs even after an identity is removed.

begin;

alter table public.auth_events drop constraint if exists auth_events_user_id_fkey;
alter table public.auth_events drop constraint if exists auth_events_organization_id_fkey;
alter table public.audit_events drop constraint if exists audit_events_actor_user_id_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'auth_events_organization_id_fkey'
      and conrelid = 'public.auth_events'::regclass
  ) then
    alter table public.auth_events
      add constraint auth_events_organization_id_fkey
      foreign key (organization_id) references public.organizations(id) on delete restrict not valid;
  end if;
end $$;

alter table public.auth_events validate constraint auth_events_organization_id_fkey;

comment on column public.auth_events.user_id is
  'Historical actor UUID. Deliberately not a foreign key so append-only events survive identity removal.';
comment on column public.audit_events.actor_user_id is
  'Historical actor UUID. Deliberately not a foreign key so append-only audit evidence survives identity removal.';

insert into public.migration_audit (migration, note)
select
  '20260825120600_preserve_audit_identity_history',
  'Removed actor FKs that required forbidden event mutation on identity deletion; preserved immutable actor UUID evidence and made Auth organization deletion restrictive.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825120600_preserve_audit_identity_history'
);

commit;
