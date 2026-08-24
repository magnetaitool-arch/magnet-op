-- Magnet OS SaaS foundation — ADDITIVE ONLY.
--
-- Creates the normalized identity/tenant/RBAC/audit/job foundation without
-- changing the legacy records table or its policies. No organization, user,
-- membership, or legacy data is created/backfilled here. New tables are locked
-- from anon/authenticated until the canonical auth context and reviewed RLS
-- policies are deployed in a later migration.
--
-- Production gate: run only after a full service-role backup and staging restore.

begin;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  slug text not null check (slug = lower(btrim(slug)) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  logo_url text,
  status text not null default 'ACTIVE'
    check (status in ('PENDING_SETUP','ACTIVE','SUSPENDED','DISABLED','ARCHIVED')),
  timezone text not null default 'Africa/Cairo',
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((status = 'ARCHIVED') = (deleted_at is not null))
);

create unique index if not exists organizations_slug_normalized_unique
  on public.organizations (lower(btrim(slug)));
create index if not exists organizations_active_idx
  on public.organizations (status, created_at desc)
  where deleted_at is null;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (char_length(btrim(email)) between 3 and 320),
  email_normalized text generated always as (lower(btrim(email))) stored,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
  phone text,
  avatar_url text,
  status text not null default 'PENDING_SETUP'
    check (status in ('INVITED','PENDING_VERIFICATION','PENDING_SETUP','ACTIVE','SUSPENDED','DISABLED','ARCHIVED')),
  onboarding_status text not null default 'PENDING'
    check (onboarding_status in ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((status = 'ARCHIVED') = (archived_at is not null))
);

create unique index if not exists profiles_email_normalized_unique
  on public.profiles (email_normalized);
create index if not exists profiles_status_idx
  on public.profiles (status, updated_at desc);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  key text not null check (key = lower(btrim(key)) and key ~ '^[a-z0-9_]+$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check ((is_system and organization_id is null) or (not is_system and organization_id is not null))
);

create unique index if not exists roles_organization_key_unique
  on public.roles (organization_id, key)
  where organization_id is not null;
create unique index if not exists roles_system_key_unique
  on public.roles (key)
  where organization_id is null;

create table if not exists public.capabilities (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key = lower(btrim(key)) and key ~ '^[a-z0-9_.]+$'),
  description text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.role_capabilities (
  role_id uuid not null references public.roles(id) on delete cascade,
  capability_id uuid not null references public.capabilities(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (role_id, capability_id)
);
create index if not exists role_capabilities_capability_idx
  on public.role_capabilities (capability_id, role_id);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role_id uuid not null,
  status text not null default 'ACTIVE'
    check (status in ('INVITED','PENDING_SETUP','ACTIVE','SUSPENDED','DISABLED','ARCHIVED')),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, user_id),
  foreign key (role_id, organization_id)
    references public.roles(id, organization_id) on delete restrict,
  check ((status = 'ARCHIVED') = (archived_at is not null)),
  check (status <> 'ACTIVE' or joined_at is not null)
);

create index if not exists organization_members_user_status_idx
  on public.organization_members (user_id, status, organization_id);
create index if not exists organization_members_org_role_status_idx
  on public.organization_members (organization_id, role_id, status);

create table if not exists public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role_id uuid not null,
  email text not null check (char_length(btrim(email)) between 3 and 320),
  email_normalized text generated always as (lower(btrim(email))) stored,
  token_hash text not null unique check (char_length(token_hash) >= 43),
  status text not null default 'PENDING'
    check (status in ('PENDING','SENT','ACCEPTED','EXPIRED','REVOKED')),
  invited_by uuid references public.profiles(user_id) on delete set null,
  accepted_by uuid references public.profiles(user_id) on delete set null,
  expires_at timestamptz not null,
  sent_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (role_id, organization_id)
    references public.roles(id, organization_id) on delete restrict,
  unique (organization_id, idempotency_key),
  check (expires_at > created_at),
  check ((status = 'ACCEPTED') = (accepted_at is not null)),
  check ((status = 'REVOKED') = (revoked_at is not null))
);

create index if not exists invitations_org_email_status_idx
  on public.organization_invitations (organization_id, email_normalized, status, expires_at desc);
create index if not exists invitations_pending_expiry_idx
  on public.organization_invitations (expires_at)
  where status in ('PENDING','SENT');

create table if not exists public.auth_events (
  id bigint generated always as identity primary key,
  request_id uuid not null default gen_random_uuid(),
  event_type text not null check (char_length(btrim(event_type)) between 1 and 100),
  success boolean not null,
  error_category text,
  user_id uuid references public.profiles(user_id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  safe_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists auth_events_type_time_idx
  on public.auth_events (event_type, occurred_at desc);
create index if not exists auth_events_user_time_idx
  on public.auth_events (user_id, occurred_at desc)
  where user_id is not null;
create index if not exists auth_events_failure_time_idx
  on public.auth_events (error_category, occurred_at desc)
  where not success;

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  request_id uuid not null default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete restrict,
  actor_user_id uuid references public.profiles(user_id) on delete set null,
  action text not null check (char_length(btrim(action)) between 1 and 120),
  entity_type text not null check (char_length(btrim(entity_type)) between 1 and 100),
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  safe_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists audit_events_org_time_idx
  on public.audit_events (organization_id, occurred_at desc, id desc);
create index if not exists audit_events_entity_idx
  on public.audit_events (organization_id, entity_type, entity_id, occurred_at desc);
create index if not exists audit_events_actor_idx
  on public.audit_events (actor_user_id, occurred_at desc)
  where actor_user_id is not null;

create or replace function public.prevent_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only; write a compensating event instead', tg_table_name;
end;
$$;

revoke all on function public.prevent_event_mutation() from public, anon, authenticated;

drop trigger if exists auth_events_append_only on public.auth_events;
create trigger auth_events_append_only
  before update or delete on public.auth_events
  for each row execute function public.prevent_event_mutation();

drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.prevent_event_mutation();

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  actor_user_id uuid references public.profiles(user_id) on delete set null,
  scope text not null check (char_length(btrim(scope)) between 1 and 100),
  key text not null check (char_length(btrim(key)) between 8 and 200),
  request_hash text not null check (char_length(request_hash) >= 43),
  status text not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS','COMPLETED','FAILED')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (organization_id, scope, key),
  check (expires_at > created_at)
);

create unique index if not exists idempotency_platform_scope_key_unique
  on public.idempotency_keys (scope, key)
  where organization_id is null;
create index if not exists idempotency_expiry_idx
  on public.idempotency_keys (expires_at);

create table if not exists public.outbox_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete restrict,
  kind text not null check (char_length(btrim(kind)) between 1 and 80),
  recipient_ref text,
  payload jsonb not null,
  idempotency_key text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING','PROCESSING','DELIVERED','FAILED','SUPPRESSED','CANCELLED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  provider_message_id text,
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kind, idempotency_key)
);

create unique index if not exists outbox_platform_kind_idempotency_unique
  on public.outbox_messages (kind, idempotency_key)
  where organization_id is null;
create index if not exists outbox_ready_idx
  on public.outbox_messages (next_attempt_at, created_at)
  where status in ('PENDING','FAILED');

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  job_type text not null check (char_length(btrim(job_type)) between 1 and 100),
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','DEAD')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 100),
  run_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  locked_by text,
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, job_type, idempotency_key)
);

create unique index if not exists jobs_platform_type_idempotency_unique
  on public.jobs (job_type, idempotency_key)
  where organization_id is null;
create index if not exists jobs_ready_idx
  on public.jobs (run_at, created_at)
  where status in ('PENDING','FAILED');

create table if not exists public.legacy_record_tenant_map (
  record_id text primary key references public.records(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  migration_status text not null default 'PENDING'
    check (migration_status in ('PENDING','VALIDATED','MIGRATED','CONFLICT','IGNORED')),
  ownership_source text not null,
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists legacy_record_tenant_org_status_idx
  on public.legacy_record_tenant_map (organization_id, migration_status, record_id);

create table if not exists public.legacy_identity_links (
  legacy_account_row_id text primary key,
  auth_user_id uuid references auth.users(id) on delete restrict,
  employee_record_id text,
  link_status text not null default 'PENDING'
    check (link_status in ('PENDING','CONFIRMED','CONFLICT','MISSING_AUTH','MISSING_PROFILE','IGNORED')),
  evidence jsonb not null default '{}'::jsonb,
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists legacy_identity_confirmed_auth_unique
  on public.legacy_identity_links (auth_user_id)
  where link_status = 'CONFIRMED' and auth_user_id is not null;
create index if not exists legacy_identity_status_idx
  on public.legacy_identity_links (link_status, updated_at desc);

create or replace function public.set_saas_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_saas_updated_at() from public, anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations','profiles','roles','organization_members',
    'organization_invitations','idempotency_keys','outbox_messages','jobs',
    'legacy_record_tenant_map','legacy_identity_links'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_set_updated_at', table_name);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_saas_updated_at()',
      table_name || '_set_updated_at', table_name
    );
  end loop;
end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations','profiles','roles','capabilities','role_capabilities',
    'organization_members','organization_invitations','auth_events','audit_events',
    'idempotency_keys','outbox_messages','jobs','legacy_record_tenant_map',
    'legacy_identity_links'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all privileges on public.%I from public', table_name);
    execute format('revoke all privileges on public.%I from anon', table_name);
    execute format('revoke all privileges on public.%I from authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
  end loop;
end $$;

grant usage, select on sequence public.auth_events_id_seq to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;

insert into public.capabilities (key, description)
values
  ('organization.manage', 'Manage organization settings and lifecycle'),
  ('members.manage', 'Invite, edit, suspend, and diagnose organization members'),
  ('clients.read', 'Read organization client records'),
  ('clients.manage', 'Create and manage organization clients'),
  ('work.read', 'Read projects, tasks, deliverables, and workflows'),
  ('work.manage', 'Create and transition projects, tasks, deliverables, and workflows'),
  ('approvals.manage', 'Review and transition approval requests'),
  ('reports.read', 'Read client and agency reports'),
  ('reports.manage', 'Generate, edit, and send reports'),
  ('hr.read', 'Read general team and HR records'),
  ('hr.manage', 'Manage team and HR workflows'),
  ('hr.sensitive.read', 'Read restricted employee identity and compensation data'),
  ('finance.read', 'Read organization finance records'),
  ('finance.manage', 'Manage organization finance and payroll records'),
  ('audit.read', 'Read authorized organization audit events')
on conflict (key) do update set description = excluded.description;

insert into public.migration_audit (migration, note)
select
  '20260816101341_saas_identity_tenancy_foundation',
  'Created locked additive SaaS identity, organization, membership, RBAC, invitation, auth/audit, idempotency, outbox/job, and legacy mapping tables; no production data backfilled and no legacy policy changed.'
where not exists (
  select 1
  from public.migration_audit
  where migration = '20260816101341_saas_identity_tenancy_foundation'
);

commit;

-- Verification before any backfill:
--   * all new tables exist, are empty except capabilities, and have RLS enabled
--   * anon/authenticated have no table privileges or policies
--   * service_role can perform the planned staging reconciliation
--   * legacy public.records row count/checksum is unchanged
--
-- Rollback: do not drop these tables after production writes begin. Before any
-- writes, rollback is to leave the locked additive tables unused and disable the
-- application feature flag. A later reviewed forward migration can remove them.
