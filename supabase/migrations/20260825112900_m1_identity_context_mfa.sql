-- MAGNET OS V2 / M1.2 — canonical identity context and MFA foundation.
--
-- Additive, tenant-aware, and fail-closed. Browser roles never write identity,
-- membership, alias, session, or MFA state directly. Server functions resolve
-- the live user/membership/capability context for every protected request.

begin;

create table if not exists public.login_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  alias_type text not null check (alias_type in ('EMAIL','USERNAME','PHONE')),
  alias_value text not null check (char_length(btrim(alias_value)) between 1 and 320),
  alias_normalized text generated always as (lower(btrim(alias_value))) stored,
  is_primary boolean not null default false,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED')),
  source text not null default 'CANONICAL' check (source in ('CANONICAL','LEGACY_ACCOUNT','LEGACY_PROFILE','INVITATION')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alias_type, alias_normalized)
);

create unique index if not exists login_aliases_user_primary_type_unique
  on public.login_aliases (user_id, alias_type)
  where is_primary and status = 'ACTIVE';
create index if not exists login_aliases_user_status_idx
  on public.login_aliases (user_id, status, alias_type);

create table if not exists public.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('WHATSAPP')),
  destination_ref text not null check (destination_ref in ('PROFILE_PHONE')),
  destination_hash text not null check (char_length(destination_hash) >= 43),
  status text not null default 'PENDING' check (status in ('PENDING','ACTIVE','DISABLED','REVOKED')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, channel),
  check ((status = 'ACTIVE') = (verified_at is not null)),
  check ((status = 'REVOKED') = (revoked_at is not null))
);

create table if not exists public.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  factor_id uuid references public.mfa_factors(id) on delete restrict,
  purpose text not null check (purpose in ('LOGIN','NEW_DEVICE','SENSITIVE_ACTION','RECOVERY')),
  code_hash text not null check (char_length(code_hash) >= 43),
  destination_hash text not null check (char_length(destination_hash) >= 43),
  status text not null default 'PENDING'
    check (status in ('PENDING','VERIFIED','EXPIRED','LOCKED','CANCELLED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  expires_at timestamptz not null,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (status <> 'VERIFIED' or verified_at is not null)
);

create index if not exists mfa_challenges_pending_user_idx
  on public.mfa_challenges (user_id, purpose, expires_at desc)
  where status = 'PENDING';
create index if not exists mfa_challenges_expiry_idx
  on public.mfa_challenges (expires_at)
  where status = 'PENDING';

create table if not exists public.trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_hash text not null check (char_length(device_hash) >= 43),
  label text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED','EXPIRED')),
  trusted_until timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, device_hash),
  check (trusted_until > created_at),
  check ((status = 'REVOKED') = (revoked_at is not null))
);

create index if not exists trusted_devices_active_user_idx
  on public.trusted_devices (user_id, trusted_until desc)
  where status = 'ACTIVE';

create table if not exists public.auth_rate_limits (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('LOGIN','MFA_SEND','MFA_VERIFY','RECOVERY','INVITE')),
  subject_hash text not null check (char_length(subject_hash) >= 43),
  window_started_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default now(),
  unique (scope, subject_hash)
);

create or replace function public.is_active_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members membership
    join public.organizations organization on organization.id = membership.organization_id
    join public.profiles profile on profile.id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.status = 'ACTIVE'
      and organization.status = 'ACTIVE'
      and organization.deleted_at is null
      and profile.identity_status = 'ACTIVE'
  );
$$;

create or replace function public.has_org_capability(p_organization_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members membership
    join public.organizations organization on organization.id = membership.organization_id
    join public.profiles profile on profile.id = membership.user_id
    join public.organization_roles organization_role on organization_role.id = membership.role_id
      and organization_role.organization_id = membership.organization_id
    join public.role_capabilities role_capability on role_capability.role_id = organization_role.id
    join public.capabilities capability on capability.id = role_capability.capability_id
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.status = 'ACTIVE'
      and organization.status = 'ACTIVE'
      and organization.deleted_at is null
      and profile.identity_status = 'ACTIVE'
      and capability.key = lower(btrim(p_capability))
  );
$$;

create or replace function public.current_identity_context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when profile.id is null then null else jsonb_build_object(
    'userId', profile.id,
    'email', profile.email_normalized,
    'displayName', profile.display_name,
    'status', profile.identity_status,
    'onboardingStatus', profile.onboarding_status,
    'sessionEpoch', profile.session_epoch,
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', membership.id,
        'organizationId', organization.id,
        'organizationName', organization.name,
        'organizationSlug', organization.slug,
        'organizationStatus', organization.status,
        'membershipStatus', membership.status,
        'roleId', organization_role.id,
        'roleKey', organization_role.key,
        'roleName', organization_role.name,
        'capabilities', coalesce((
          select jsonb_agg(capability.key order by capability.key)
          from public.role_capabilities role_capability
          join public.capabilities capability on capability.id = role_capability.capability_id
          where role_capability.role_id = organization_role.id
        ), '[]'::jsonb)
      ) order by organization.name, organization.id)
      from public.organization_members membership
      join public.organizations organization on organization.id = membership.organization_id
      join public.organization_roles organization_role on organization_role.id = membership.role_id
      where membership.user_id = profile.id
        and membership.status <> 'ARCHIVED'
        and organization.deleted_at is null
    ), '[]'::jsonb)
  ) end
  from public.profiles profile
  where profile.id = auth.uid();
$$;

revoke all on function public.is_active_org_member(uuid) from public, anon;
revoke all on function public.has_org_capability(uuid, text) from public, anon;
revoke all on function public.current_identity_context() from public, anon;
grant execute on function public.is_active_org_member(uuid) to authenticated, service_role;
grant execute on function public.has_org_capability(uuid, text) to authenticated, service_role;
grant execute on function public.current_identity_context() to authenticated, service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'login_aliases','mfa_factors','mfa_challenges','trusted_devices','auth_rate_limits'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all privileges on public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
  end loop;
end $$;

drop trigger if exists login_aliases_set_updated_at on public.login_aliases;
create trigger login_aliases_set_updated_at before update on public.login_aliases
  for each row execute function public.set_saas_updated_at();
drop trigger if exists mfa_factors_set_updated_at on public.mfa_factors;
create trigger mfa_factors_set_updated_at before update on public.mfa_factors
  for each row execute function public.set_saas_updated_at();
drop trigger if exists auth_rate_limits_set_updated_at on public.auth_rate_limits;
create trigger auth_rate_limits_set_updated_at before update on public.auth_rate_limits
  for each row execute function public.set_saas_updated_at();

grant select on public.profiles to authenticated;
grant select on public.organizations to authenticated;
grant select on public.organization_roles to authenticated;
grant select on public.capabilities to authenticated;
grant select on public.role_capabilities to authenticated;
grant select on public.organization_members to authenticated;
grant select on public.audit_events to authenticated;

drop policy if exists organizations_member_read on public.organizations;
create policy organizations_member_read on public.organizations
  for select to authenticated using (public.is_active_org_member(id));

drop policy if exists organization_roles_member_read on public.organization_roles;
create policy organization_roles_member_read on public.organization_roles
  for select to authenticated using (organization_id is not null and public.is_active_org_member(organization_id));

drop policy if exists capabilities_member_read on public.capabilities;
create policy capabilities_member_read on public.capabilities
  for select to authenticated using (
    exists (
      select 1 from public.organization_members membership
      where membership.user_id = auth.uid() and membership.status = 'ACTIVE'
    )
  );

drop policy if exists role_capabilities_member_read on public.role_capabilities;
create policy role_capabilities_member_read on public.role_capabilities
  for select to authenticated using (
    exists (
      select 1 from public.organization_roles organization_role
      where organization_role.id = role_id
        and organization_role.organization_id is not null
        and public.is_active_org_member(organization_role.organization_id)
    )
  );

drop policy if exists organization_members_self_or_manager_read on public.organization_members;
create policy organization_members_self_or_manager_read on public.organization_members
  for select to authenticated using (
    user_id = auth.uid() or public.has_org_capability(organization_id, 'members.manage')
  );

drop policy if exists profiles_canonical_self_read on public.profiles;
create policy profiles_canonical_self_read on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_shared_org_manager_read on public.profiles;
create policy profiles_shared_org_manager_read on public.profiles
  for select to authenticated using (
    exists (
      select 1
      from public.organization_members target_membership
      where target_membership.user_id = profiles.id
        and target_membership.status <> 'ARCHIVED'
        and public.has_org_capability(target_membership.organization_id, 'members.manage')
    )
  );

drop policy if exists audit_events_authorized_read on public.audit_events;
create policy audit_events_authorized_read on public.audit_events
  for select to authenticated using (
    organization_id is not null and public.has_org_capability(organization_id, 'audit.read')
  );

insert into public.migration_audit (migration, note)
select
  '20260825112900_m1_identity_context_mfa',
  'Added canonical login aliases, live tenant capability context, session revision, and locked WhatsApp MFA/device/rate-limit structures. No raw OTPs or passwords are stored.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825112900_m1_identity_context_mfa'
);

commit;

-- Rollback: feature-flag the canonical identity service off. Do not drop these
-- tables after any identity or MFA writes; use a reviewed forward migration.
