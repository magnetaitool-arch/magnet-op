-- Additive function repair. No data backfill. See docs/AUTH_PROVISIONING_REPAIR.md.
-- Local rehearsal only; independent hosted staging remains a production gate.
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
  collision_constraint text;
begin
  safe_display_name := left(coalesce(
    nullif(btrim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(new.email), ''),
    new.id::text
  ),160);
  safe_username := nullif(lower(btrim(split_part(coalesce(new.email, ''), '@', 1))), '');

  loop
  begin
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
  exception when unique_violation then
    get stacked diagnostics collision_constraint = constraint_name;
    if collision_constraint <> 'profiles_username_key' or safe_username is null then
      raise;
    end if;
    -- A username is an optional alias; distinct verified emails remain identities.
    -- Retry inside the transaction so concurrent same-local-part signups are safe.
    safe_username := null;
  end;
  end loop;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

commit;
