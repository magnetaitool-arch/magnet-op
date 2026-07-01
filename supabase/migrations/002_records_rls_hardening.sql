-- ============================================================================
-- Magnet OS migration 002 — RLS hardening (STAGE A). ADDITIVE, non-destructive.
-- ----------------------------------------------------------------------------
-- GOAL: close the two worst holes WITHOUT breaking the running app.
--   * anon could SELECT every user's password hash (coll='_accounts')  -> FIXED
--   * anon could INSERT/UPDATE a fake Owner account                    -> FIXED
--
-- WHY ONLY _accounts? The app is a browser client that talks to Postgres with the
-- PUBLIC anon key for ALL business collections (clients, invoices, employees…).
-- Blocking anon SELECT on those would break the live app. Truly hiding finance/HR
-- data from anon requires migrating sign-in to Supabase Auth (per-user JWT) — that
-- is STAGE B (see supabase-auth-migration.sql + SUPABASE_SECURITY_GUIDE.md) and is
-- a larger, app-breaking change, so it is intentionally NOT applied here.
--
-- PRECONDITION: deploy the accounts Edge Function FIRST (it uses the service_role
-- key and bypasses RLS, so login/account writes keep working after this runs).
--   supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd
--
-- IDEMPOTENT: drops-then-creates the named policies, so re-running is safe.
-- ROLLBACK: see the block at the bottom (restores the fully-open "team access").
-- ============================================================================

alter table public.records enable row level security;

-- Clean re-run: remove any prior variants of these policies.
drop policy if exists "team access"        on public.records;
drop policy if exists records_anon_select   on public.records;
drop policy if exists records_anon_insert   on public.records;
drop policy if exists records_anon_update   on public.records;
drop policy if exists records_anon_delete   on public.records;
drop policy if exists records_anon_public_read   on public.records;
drop policy if exists records_anon_public_insert on public.records;

-- anon may read/write EVERY collection EXCEPT _accounts. _accounts is reachable
-- only through the service_role Edge Function (which bypasses RLS).
create policy records_anon_select on public.records
  for select to anon using      (coll <> '_accounts');
create policy records_anon_insert on public.records
  for insert to anon with check (coll <> '_accounts');
create policy records_anon_update on public.records
  for update to anon using      (coll <> '_accounts') with check (coll <> '_accounts');
create policy records_anon_delete on public.records
  for delete to anon using      (coll <> '_accounts');

-- Remove leftover SECURITY DEFINER functions callable by anon (advisor findings
-- from an earlier Auth attempt; the app does not use them).
do $$ begin
  begin revoke execute on function public.current_role()   from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.handle_new_user() from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.has_scope(text)   from anon, authenticated; exception when undefined_function then null; end;
end $$;

insert into public.migration_audit (migration, note)
values ('002_records_rls_hardening', 'anon blocked from _accounts (select/insert/update/delete); revoked leftover definer funcs');

-- ---------- verification ----------
-- With the ANON key, this must now return 401/403 (was 200 before):
--   curl -s "$SUPABASE_URL/rest/v1/records?select=id&coll=eq._accounts&limit=1" -H "apikey: $ANON"
-- Business collections must still return 200:
--   curl -s "$SUPABASE_URL/rest/v1/records?select=id&coll=eq.clients&limit=1"    -H "apikey: $ANON"

-- ============================================================================
-- ROLLBACK (only if login/account sync breaks and the Edge Function is down):
--   drop policy if exists records_anon_select on public.records;
--   drop policy if exists records_anon_insert on public.records;
--   drop policy if exists records_anon_update on public.records;
--   drop policy if exists records_anon_delete on public.records;
--   create policy "team access" on public.records for all to anon, authenticated
--     using (true) with check (true);
-- ============================================================================
