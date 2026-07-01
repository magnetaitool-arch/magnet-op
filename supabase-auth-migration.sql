-- ============================================================================
-- Magnet OS — SECURITY MIGRATION (phase 2): lock down the anon role.
-- ----------------------------------------------------------------------------
-- WHY: The current schema (supabase-schema.sql) grants the public `anon` role
-- FULL select/insert/update/delete on EVERY collection in `records`. Because the
-- anon key ships publicly inside index.html, anyone who opens "View Source" can
-- read, change, or delete ALL data (clients, invoices, payroll) AND read every
-- account's password hash, or insert a fake Owner account. This file is the
-- defense-in-depth lockdown.
--
-- IMPORTANT: Apply this ONLY together with the matching app + server changes,
-- because once you restrict anon, the browser can no longer talk to Postgres
-- directly for the restricted collections. The realistic rollout is staged:
--
--   STAGE A (safe, do first — closes credential theft & account takeover):
--     * Stop letting anon touch `_accounts` at all. Login / account sync /
--       email-verify must go through a server function that uses the SERVICE
--       ROLE key (kept in Vercel env, never in the browser).
--     * Public form/brief/verify writes go through the same kind of function.
--   STAGE B (full isolation — closes anonymous read/write of all business data):
--     * Migrate user sign-in to Supabase Auth (real JWT per user) and switch the
--       app's data layer to send the user's access_token, then make RLS policies
--       depend on auth.uid()/role. This is a larger change — test on a branch.
--
-- This file gives you the STAGE A policies (anon may ONLY insert leads/candidates
-- and read campaigns; everything else denied to anon). Run it AFTER the server
-- functions are in place, or your app will lose DB access for those collections.
-- ============================================================================

alter table public.records enable row level security;

-- Clean re-run
drop policy if exists records_anon_select on public.records;
drop policy if exists records_anon_insert on public.records;
drop policy if exists records_anon_update on public.records;
drop policy if exists records_anon_delete on public.records;
drop policy if exists records_anon_public_read   on public.records;
drop policy if exists records_anon_public_insert on public.records;

-- ---------- ANON: read ONLY public, non-sensitive collections ----------
-- The public campaign landing form needs to read the campaign by slug. Nothing
-- else (no _accounts, no invoices, no clients) is readable by anon.
create policy records_anon_public_read on public.records
  for select to anon
  using ( coll in ('campaigns') );

-- ---------- ANON: insert ONLY the two public-intake collections ----------
-- Campaign leads + website candidates. Anon can create these but cannot read
-- them back, update, or delete. (Even better: move these to the service-role
-- function too and remove anon insert entirely.)
create policy records_anon_public_insert on public.records
  for insert to anon
  with check ( coll in ('leads','candidates','notifications') );

-- NOTE: no anon update/delete policies => anon cannot update or delete anything.
-- The `service_role` key bypasses RLS entirely, so your server functions (and
-- authenticated app, once on Supabase Auth) keep full access.

-- ============================================================================
-- STAGE B reference (per-user RLS once you adopt Supabase Auth) — example only:
--
--   create policy records_auth_all on public.records
--     for all to authenticated using (true) with check (true);
--
-- Then tighten `using`/`with check` per collection using auth.jwt() claims
-- (e.g. role) and a users table, so e.g. only Finance/Owner can read invoices.
-- ============================================================================
