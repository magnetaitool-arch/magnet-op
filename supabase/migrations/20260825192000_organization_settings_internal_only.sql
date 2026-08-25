-- MAGNET OS V2 / M3.2: keep operational settings out of client portals.
--
-- The settings JSON contains attendance, payroll, report automation, and agency
-- operating rules. Active staff may read it; client memberships receive no row.

begin;

drop policy if exists organization_settings_member_read on public.organization_settings;
create policy organization_settings_member_read on public.organization_settings
for select to authenticated
using (
  public.is_active_org_member(organization_id)
  and public.current_member_role_key(organization_id) <> 'client'
);

insert into public.migration_audit (migration, note)
values (
  '20260825192000_organization_settings_internal_only',
  'Restricted operational organization settings reads to internal members; client portal identities receive no settings row. No production application or database was changed.'
);

commit;

-- Rollback is forward-only: retain the client privacy boundary and expose only
-- an explicit safe client-settings projection if the portal later needs one.
