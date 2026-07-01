-- ============================================================================
-- Magnet OS — _accounts lockdown (run ONLY after the `accounts` Edge Function is
-- deployed AND the app is updated to route login/account ops through it).
--
-- WHAT IT DOES: keeps anon (the public key in index.html) working for all normal
-- collections, but fully blocks anon from reading OR writing `_accounts`. That
-- closes the two worst holes:
--   • anon could dump every user's password hash  (SELECT _accounts)  -> FIXED
--   • anon could create/overwrite an Owner account (INSERT/UPDATE)    -> FIXED
-- The service_role Edge Function bypasses RLS, so login still works.
--
-- REVERSIBLE: to roll back, drop the 4 policies below and recreate the single
-- permissive "team access" policy (see bottom).
-- ============================================================================

alter table public.records enable row level security;

drop policy if exists "team access"          on public.records;
drop policy if exists records_anon_select     on public.records;
drop policy if exists records_anon_insert     on public.records;
drop policy if exists records_anon_update     on public.records;
drop policy if exists records_anon_delete     on public.records;

-- anon may touch every collection EXCEPT _accounts:
create policy records_anon_select on public.records for select to anon using      (coll <> '_accounts');
create policy records_anon_insert on public.records for insert to anon with check (coll <> '_accounts');
create policy records_anon_update on public.records for update to anon using      (coll <> '_accounts') with check (coll <> '_accounts');
create policy records_anon_delete on public.records for delete to anon using      (coll <> '_accounts');

-- ---- Clean up leftover SECURITY DEFINER functions callable by anon (advisors) ----
-- (These are remnants of an earlier Auth attempt; the app does not use them.)
do $$ begin
  begin revoke execute on function public.current_role()   from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.handle_new_user() from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.has_scope(text)   from anon, authenticated; exception when undefined_function then null; end;
end $$;

-- ============================================================================
-- ROLLBACK (if login ever breaks, run this to restore the old open behaviour):
--   drop policy if exists records_anon_select on public.records;
--   drop policy if exists records_anon_insert on public.records;
--   drop policy if exists records_anon_update on public.records;
--   drop policy if exists records_anon_delete on public.records;
--   create policy "team access" on public.records for all to anon, authenticated
--     using (true) with check (true);
-- ============================================================================
