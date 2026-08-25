-- MAGNET OS V2 / M2: make tenant ownership and authorization authoritative.
--
-- This migration is additive for business data. It backfills the restored Magnet
-- snapshot to the already-reviewed `magnet` organization, removes all anonymous
-- access, quarantines unused legacy tables, and replaces the permissive records
-- policies with live membership/capability checks.
--
-- Apply to STAGING first. Production remains gated by a fresh backup, resolved
-- quota, and an explicit rollout authorization.

begin;

alter table public.records
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;

do $$
declare
  magnet_organization_id uuid;
begin
  select id into magnet_organization_id
  from public.organizations
  where slug = 'magnet' and status = 'ACTIVE' and deleted_at is null;

  if magnet_organization_id is null then
    raise exception 'Active Magnet organization is missing; refusing records tenant backfill';
  end if;

  update public.records
  set organization_id = magnet_organization_id
  where organization_id is null;

  if exists (select 1 from public.records where organization_id is null) then
    raise exception 'Tenant backfill incomplete; refusing to enforce NOT NULL';
  end if;
end $$;

alter table public.records alter column organization_id set not null;
create index if not exists records_organization_coll_updated_idx
  on public.records (organization_id, coll, updated_at desc);
create index if not exists records_organization_deleted_idx
  on public.records (organization_id, deleted_at)
  where deleted_at is not null;

-- A mapping row is an owned child of a legacy record. Cascading only this
-- metadata makes audited service cleanup possible without leaving stale maps.
alter table public.legacy_record_tenant_map
  drop constraint if exists legacy_record_tenant_map_record_id_fkey;
alter table public.legacy_record_tenant_map
  add constraint legacy_record_tenant_map_record_id_fkey
  foreign key (record_id) references public.records(id) on delete cascade;

insert into public.legacy_record_tenant_map (
  record_id, organization_id, migration_status, ownership_source, validated_at
)
select
  record.id,
  record.organization_id,
  'VALIDATED',
  'restored_single_agency_snapshot',
  now()
from public.records record
on conflict (record_id) do update
set
  organization_id = excluded.organization_id,
  migration_status = 'VALIDATED',
  ownership_source = excluded.ownership_source,
  validated_at = excluded.validated_at,
  updated_at = now();

create or replace function public.sync_record_tenant_map()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.organization_id <> old.organization_id then
    raise exception 'record organization_id is immutable';
  end if;

  insert into public.legacy_record_tenant_map (
    record_id, organization_id, migration_status, ownership_source, validated_at
  ) values (
    new.id, new.organization_id, 'VALIDATED', 'authoritative_records_column', now()
  )
  on conflict (record_id) do update
  set
    organization_id = excluded.organization_id,
    migration_status = 'VALIDATED',
    ownership_source = excluded.ownership_source,
    validated_at = excluded.validated_at,
    updated_at = now();
  return new;
end;
$$;

revoke all on function public.sync_record_tenant_map() from public, anon, authenticated;
drop trigger if exists records_sync_tenant_map on public.records;
create trigger records_sync_tenant_map
  after insert or update of organization_id on public.records
  for each row execute function public.sync_record_tenant_map();

create or replace function public.current_member_role_key(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select organization_role.key
  from public.organization_members membership
  join public.organization_roles organization_role
    on organization_role.id = membership.role_id
   and organization_role.organization_id = membership.organization_id
  join public.organizations organization on organization.id = membership.organization_id
  join public.profiles profile on profile.id = membership.user_id
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid()
    and membership.status = 'ACTIVE'
    and organization.status = 'ACTIVE'
    and organization.deleted_at is null
    and profile.identity_status = 'ACTIVE'
  limit 1;
$$;

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
        p_data->>'userId', p_data->>'employeeId', p_data->>'assignedTo',
        p_data->>'requestedBy', p_data->>'createdBy', p_data->>'ownerId',
        p_data->>'authorId', p_data->>'senderId', p_data->>'reviewerId'
      ])
  );
$$;

create or replace function public.record_matches_current_client(p_data jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and nullif(profile.client_id, '') is not null
      and profile.client_id = any (array[p_data->>'clientId', p_data->>'id'])
  );
$$;

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

  if p_collection = any (array['employees','attendance','leaves','performanceReviews']) then
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

create or replace function public.records_can_write(
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
    return public.has_org_capability(p_organization_id, 'clients.manage');
  end if;

  if p_collection = any (array[
    'projects','tasks','deliverables','clientAssets','files','revisions','meetings','plans'
  ]) then
    return public.has_org_capability(p_organization_id, 'work.manage');
  end if;

  if p_collection = any (array['chatMessages','comments']) then
    return public.has_org_capability(p_organization_id, 'work.manage')
      or (public.has_org_capability(p_organization_id, 'work.read') and public.record_matches_current_user(p_data));
  end if;

  if p_collection = 'approvalRequests' then
    return public.has_org_capability(p_organization_id, 'approvals.manage')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = any (array['employees','candidates','freelancers','attendance','leaves','performanceReviews']) then
    return public.has_org_capability(p_organization_id, 'hr.manage')
      or (p_collection in ('attendance','leaves') and public.record_matches_current_user(p_data));
  end if;

  if p_collection = any (array[
    'invoices','payments','expenses','fixedCosts','partnerSettlements','collections','employeePayments'
  ]) then
    return public.has_org_capability(p_organization_id, 'finance.manage');
  end if;

  if p_collection = 'reports' then
    return public.has_org_capability(p_organization_id, 'reports.manage');
  end if;

  if p_collection = 'activityLogs' then return public.record_matches_current_user(p_data); end if;
  if p_collection = 'notifications' then return true; end if;
  if p_collection = any (array['gameScores','gameStats']) then return public.record_matches_current_user(p_data); end if;
  if p_collection = any (array['departments','services']) then
    return public.has_org_capability(p_organization_id, 'organization.manage');
  end if;

  return false;
end;
$$;

revoke all on function public.current_member_role_key(uuid) from public, anon;
revoke all on function public.record_matches_current_user(jsonb) from public, anon;
revoke all on function public.record_matches_current_client(jsonb) from public, anon;
revoke all on function public.records_can_read(uuid, text, jsonb) from public, anon;
revoke all on function public.records_can_write(uuid, text, jsonb) from public, anon;
grant execute on function public.current_member_role_key(uuid) to authenticated;
grant execute on function public.record_matches_current_user(jsonb) to authenticated;
grant execute on function public.record_matches_current_client(jsonb) to authenticated;
grant execute on function public.records_can_read(uuid, text, jsonb) to authenticated;
grant execute on function public.records_can_write(uuid, text, jsonb) to authenticated;

-- Align canonical capabilities with the product role matrix. The database is
-- the authority; stale browser labels cannot grant these permissions.
with grants(role_key, capability_key) as (
  values
    ('sales', 'work.manage'),
    ('hr', 'reports.manage')
)
insert into public.role_capabilities (role_id, capability_id)
select organization_role.id, capability.id
from grants requested
join public.organization_roles organization_role on organization_role.key = requested.role_key
join public.capabilities capability on capability.key = requested.capability_key
where organization_role.organization_id is not null
on conflict do nothing;

alter table public.records enable row level security;
revoke all privileges on public.records from public, anon, authenticated;
grant select, insert, update on public.records to authenticated;
grant select, insert, update, delete on public.records to service_role;

do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'records'
  loop
    execute format('drop policy if exists %I on public.records', policy_record.policyname);
  end loop;
end $$;

create policy records_authenticated_select on public.records
  for select to authenticated
  using (public.records_can_read(organization_id, coll, data));

create policy records_authenticated_insert on public.records
  for insert to authenticated
  with check (public.records_can_write(organization_id, coll, data));

create policy records_authenticated_update on public.records
  for update to authenticated
  using (public.records_can_write(organization_id, coll, data))
  with check (public.records_can_write(organization_id, coll, data));

-- No authenticated DELETE policy is intentional. The application writes an
-- audited tombstone and service cleanup remains server-only.

create or replace function public.submit_public_brief(
  p_organization_id uuid,
  p_token text,
  p_answers jsonb,
  p_notification_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  brief_record public.records%rowtype;
  submitted_at timestamptz := now();
  updated_data jsonb;
begin
  if p_token is null or char_length(p_token) < 16 then
    raise exception 'invalid brief token';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or pg_column_size(p_answers) > 100000 then
    raise exception 'invalid brief answers';
  end if;
  if p_notification_id is null or char_length(p_notification_id) > 160 then
    raise exception 'invalid notification id';
  end if;

  select * into brief_record
  from public.records record
  where record.organization_id = p_organization_id
    and record.coll = 'briefs'
    and record.data->>'token' = p_token
    and record.deleted_at is null
  for update;

  if brief_record.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if brief_record.data->>'status' = 'submitted' then
    return jsonb_build_object('ok', true, 'alreadySubmitted', true, 'id', brief_record.id);
  end if;

  updated_data := brief_record.data || jsonb_build_object(
    'answers', p_answers,
    'status', 'submitted',
    'submittedAt', submitted_at,
    'updatedAt', submitted_at,
    'clientName', coalesce(p_answers->>'contactName', brief_record.data->>'clientName'),
    'company', coalesce(p_answers->>'company', brief_record.data->>'company'),
    'contactPhone', coalesce(p_answers->>'whatsapp', brief_record.data->>'contactPhone'),
    'contactEmail', coalesce(p_answers->>'email', brief_record.data->>'contactEmail'),
    'projectType', coalesce(p_answers->>'projectType', brief_record.data->>'projectType')
  );

  update public.records
  set data = updated_data
  where id = brief_record.id;

  insert into public.records (id, coll, data, organization_id)
  values (
    p_notification_id,
    'notifications',
    jsonb_build_object(
      'id', p_notification_id,
      'userId', null,
      'role', 'Sales',
      'title', 'New client brief submitted',
      'message', coalesce(updated_data->>'company', updated_data->>'clientName', 'A client') || ' completed the brief',
      'entityType', 'briefs',
      'entityId', brief_record.id,
      'read', false,
      'createdAt', submitted_at
    ),
    p_organization_id
  )
  on conflict (id) do nothing;

  return jsonb_build_object('ok', true, 'alreadySubmitted', false, 'id', brief_record.id);
end;
$$;

revoke all on function public.submit_public_brief(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.submit_public_brief(uuid, text, jsonb, text) to service_role;

-- These tables are legacy/backup surfaces not used by the V2 browser. Their old
-- authenticated policies are not tenant-aware, so quarantine them until each is
-- normalized with organization_id in a reviewed later migration.
do $$
declare
  table_name text;
  policy_record record;
begin
  foreach table_name in array array[
    'accounts_backup_20260718','records_backup_001','records_backup_authmig_20260726',
    'records_backup_manual','records_backup_p0_20260726','migration_audit',
    'activity_logs','approvals','assets','client_assignments','clients','comments',
    'employees','invoices','notifications','permissions','proposals','requests',
    'roles','settings','tasks','user_data_scope','workflow_instances','workflow_steps'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('revoke all privileges on public.%I from public, anon, authenticated', table_name);
      for policy_record in
        select policyname from pg_policies where schemaname = 'public' and tablename = table_name
      loop
        execute format('drop policy if exists %I on public.%I', policy_record.policyname, table_name);
      end loop;
      execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    end if;
  end loop;
end $$;

insert into public.migration_audit (migration, note)
values (
  '20260825170000_tenant_scoped_records_rls',
  'Backfilled authoritative records.organization_id, synchronized tenant maps, removed anonymous records access, enforced live capability RLS, denied browser hard-deletes, and quarantined non-tenant-aware legacy tables.'
);

commit;

-- Rollback is forward-only: restore the prior policy definitions only after a
-- reviewed incident decision. Never remove organization_id or tenant maps.
