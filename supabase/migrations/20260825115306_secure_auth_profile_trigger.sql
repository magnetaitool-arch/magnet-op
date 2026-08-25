-- MAGNET OS V2 / M1.4 — secure profile creation for Supabase Auth users.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  safe_display_name text;
  safe_username text;
begin
  safe_display_name := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(new.email), ''),
    new.id::text
  );
  safe_username := nullif(lower(btrim(split_part(coalesce(new.email, ''), '@', 1))), '');

  insert into public.profiles (
    id, full_name, display_name, email, username, role, status,
    identity_status, onboarding_status, updated_at, session_epoch
  ) values (
    new.id, safe_display_name, safe_display_name, lower(btrim(new.email)), safe_username,
    'Viewer'::public.app_role, 'Active'::public.user_status,
    'PENDING_SETUP', 'PENDING', now(), 0
  )
  on conflict (id) do update
  set
    email = excluded.email,
    display_name = coalesce(nullif(public.profiles.display_name, ''), excluded.display_name),
    full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
    updated_at = now();

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

insert into public.migration_audit (migration, note)
select
  '20260825115306_secure_auth_profile_trigger',
  'Updated Auth profile provisioning for V2 required fields; ignored untrusted role metadata and defaulted new identities to pending setup without membership.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825115306_secure_auth_profile_trigger'
);

commit;
