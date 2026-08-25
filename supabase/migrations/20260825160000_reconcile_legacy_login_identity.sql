-- MAGNET OS V2 / M1.8 — idempotent first-login reconciliation for the legacy shell.
--
-- New users are still created by the legacy single-file administration screen
-- during the controlled cutover. After the legacy password is verified and a
-- Supabase Auth user exists, this service-only command links the two identities
-- and creates a membership exactly once. Existing canonical memberships are
-- never overwritten by a stale `_accounts` role.

begin;

create or replace function public.reconcile_legacy_login_identity(
  p_auth_user_id uuid,
  p_legacy_account_row_id text,
  p_organization_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  account_data jsonb;
  role_key text;
  selected_role_id uuid;
  username_value text;
  existing_link public.legacy_identity_links%rowtype;
  existing_link_confirmed boolean := false;
  membership_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'identity_service_only' using errcode = '42501';
  end if;
  if p_auth_user_id is null or p_legacy_account_row_id is null or btrim(p_legacy_account_row_id) = '' then
    raise exception 'identity_invalid_input' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.status = 'ACTIVE'
      and organization.deleted_at is null
  ) then
    raise exception 'identity_organization_not_found' using errcode = 'P0002';
  end if;

  select * into profile_row from public.profiles profile where profile.id = p_auth_user_id for update;
  if not found then raise exception 'identity_profile_not_found' using errcode = 'P0002'; end if;

  select legacy_account.data into account_data
  from public.records legacy_account
  where legacy_account.id = p_legacy_account_row_id
    and legacy_account.coll = '_accounts'
  for update;
  if not found then raise exception 'identity_legacy_account_not_found' using errcode = 'P0002'; end if;

  if lower(btrim(coalesce(account_data->>'email', ''))) <> profile_row.email_normalized then
    raise exception 'identity_email_mismatch' using errcode = '23514';
  end if;
  if coalesce(account_data->>'status', 'Active') <> 'Active' then
    raise exception 'identity_account_inactive' using errcode = '42501';
  end if;

  role_key := case coalesce(account_data->>'role', '')
    when 'Owner' then 'owner'
    when 'Admin' then 'admin'
    when 'Manager' then 'manager'
    when 'Project Manager' then 'manager'
    when 'Sales' then 'sales'
    when 'Content' then 'content_creator'
    when 'Content Creator' then 'content_creator'
    when 'Video Editor' then 'content_creator'
    when 'Production' then 'content_creator'
    when 'Designer' then 'designer'
    when 'Graphic Designer' then 'designer'
    when 'Account Manager' then 'account_manager'
    when 'HR' then 'hr'
    when 'Finance' then 'finance'
    when 'Accountant' then 'finance'
    when 'Client' then 'client'
    else 'client'
  end;
  select organization_role.id into selected_role_id
  from public.organization_roles organization_role
  where organization_role.organization_id = p_organization_id
    and organization_role.key = role_key;
  if selected_role_id is null then raise exception 'identity_role_not_found' using errcode = 'P0002'; end if;

  select * into existing_link
  from public.legacy_identity_links link
  where link.legacy_account_row_id = p_legacy_account_row_id
  for update;
  existing_link_confirmed := found and existing_link.link_status = 'CONFIRMED';
  if found and existing_link.auth_user_id is not null and existing_link.auth_user_id <> p_auth_user_id then
    raise exception 'identity_link_conflict' using errcode = '23505';
  end if;

  insert into public.legacy_identity_links (
    legacy_account_row_id, auth_user_id, employee_record_id, link_status,
    evidence, reviewed_at
  ) values (
    p_legacy_account_row_id, p_auth_user_id, nullif(account_data->>'employeeId', ''), 'CONFIRMED',
    jsonb_build_object('method', 'verified_legacy_first_login'), now()
  )
  on conflict (legacy_account_row_id) do update
  set auth_user_id = excluded.auth_user_id,
      employee_record_id = coalesce(excluded.employee_record_id, public.legacy_identity_links.employee_record_id),
      link_status = 'CONFIRMED',
      evidence = excluded.evidence,
      reviewed_at = now();

  update public.profiles
  set display_name = coalesce(nullif(btrim(account_data->>'fullName'), ''), nullif(btrim(account_data->>'name'), ''), display_name),
      username = coalesce(nullif(btrim(account_data->>'username'), ''), username),
      identity_status = case when existing_link_confirmed then identity_status else 'ACTIVE' end,
      onboarding_status = case when existing_link_confirmed then onboarding_status else 'COMPLETED' end
  where id = p_auth_user_id;

  insert into public.organization_members (
    organization_id, user_id, role_id, status, joined_at
  ) values (
    p_organization_id, p_auth_user_id, selected_role_id, 'ACTIVE', now()
  )
  on conflict (organization_id, user_id) do nothing;

  select membership.id into membership_id
  from public.organization_members membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_auth_user_id;

  insert into public.login_aliases (user_id, alias_type, alias_value, is_primary, status, source)
  values (p_auth_user_id, 'EMAIL', profile_row.email_normalized, true, 'ACTIVE', 'LEGACY_ACCOUNT')
  on conflict (alias_type, alias_normalized) do nothing;
  if exists (
    select 1 from public.login_aliases alias
    where alias.alias_type = 'EMAIL'
      and alias.alias_normalized = profile_row.email_normalized
      and alias.user_id <> p_auth_user_id
  ) then raise exception 'identity_alias_conflict' using errcode = '23505'; end if;

  username_value := nullif(btrim(account_data->>'username'), '');
  if username_value is not null then
    insert into public.login_aliases (user_id, alias_type, alias_value, is_primary, status, source)
    values (p_auth_user_id, 'USERNAME', username_value, true, 'ACTIVE', 'LEGACY_ACCOUNT')
    on conflict (alias_type, alias_normalized) do nothing;
    if exists (
      select 1 from public.login_aliases alias
      where alias.alias_type = 'USERNAME'
        and alias.alias_normalized = lower(btrim(username_value))
        and alias.user_id <> p_auth_user_id
    ) then raise exception 'identity_alias_conflict' using errcode = '23505'; end if;
  end if;

  insert into public.audit_events (
    request_id, organization_id, actor_user_id, action, entity_type, entity_id, safe_context
  ) values (
    coalesce(p_request_id, gen_random_uuid()), p_organization_id, p_auth_user_id,
    'identity.legacy_login_reconciled', 'organization_member', membership_id::text,
    jsonb_build_object('method', 'verified_legacy_first_login')
  );

  return jsonb_build_object('ok', true, 'membershipId', membership_id);
end;
$$;

revoke all on function public.reconcile_legacy_login_identity(uuid,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.reconcile_legacy_login_identity(uuid,text,uuid,uuid) to service_role;

insert into public.migration_audit (migration, note)
select
  '20260825160000_reconcile_legacy_login_identity',
  'Added idempotent service-only first-login reconciliation. Existing memberships remain authoritative and are never overwritten by a legacy role.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825160000_reconcile_legacy_login_identity'
);

commit;

-- Rollback: stop calling the function from the Staging accounts Edge Function.
-- Preserve links and memberships; never drop identity data to roll back code.
