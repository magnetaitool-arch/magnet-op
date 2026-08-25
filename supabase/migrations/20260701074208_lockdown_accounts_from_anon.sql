-- Replace the single wide-open policy with per-command policies that exclude
-- _accounts for anon. The service_role Edge Function bypasses RLS, so login still
-- works. Reversible (see rollback in supabase-accounts-lockdown.sql).
alter table public.records enable row level security;

drop policy if exists "team access"      on public.records;
drop policy if exists records_anon_select on public.records;
drop policy if exists records_anon_insert on public.records;
drop policy if exists records_anon_update on public.records;
drop policy if exists records_anon_delete on public.records;

create policy records_anon_select on public.records for select to anon using      (coll <> '_accounts');
create policy records_anon_insert on public.records for insert to anon with check (coll <> '_accounts');
create policy records_anon_update on public.records for update to anon using      (coll <> '_accounts') with check (coll <> '_accounts');
create policy records_anon_delete on public.records for delete to anon using      (coll <> '_accounts');;
