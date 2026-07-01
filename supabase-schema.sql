-- ============================================================================
-- Magnet OS — Supabase schema (CURRENT simple model)
-- ----------------------------------------------------------------------------
-- The app stores every record as one row in a single `records` table:
--   { id, coll, data:{...record}, updated_at }
-- The browser talks to this table with the PUBLIC ANON KEY only (no service
-- role in the browser). Run this whole file once in:
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- SECURITY NOTE (read this):
-- The app does NOT use Supabase Auth — it authenticates users in the browser
-- (localStorage) and every request reaches Postgres as the `anon` role. Because
-- the anon key ships publicly inside index.html, RLS below is DEFENSE-IN-DEPTH,
-- not strong per-user isolation. The real protections are:
--   1) Public website form submissions go through the server-side Netlify
--      function (netlify/functions/intake.js) using a SERVICE_ROLE key kept in
--      Netlify env — the public forms never hold DB credentials and can only
--      create `candidates` / `leads`.
--   2) (Optional future phase) migrate to Supabase Auth for true per-user RLS.
-- ============================================================================

-- ---------- table ----------
create table if not exists public.records (
  id          text primary key,
  coll        text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------- indexes ----------
-- The app filters by collection (coll=eq.<name>) and orders/syncs by recency.
create index if not exists records_coll_idx       on public.records (coll);
create index if not exists records_updated_at_idx  on public.records (updated_at desc);
-- Optional: GIN index to query inside the JSON payload later.
create index if not exists records_data_gin_idx    on public.records using gin (data);

-- ---------- auto-update updated_at on every UPDATE ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists records_set_updated_at on public.records;
create trigger records_set_updated_at
  before update on public.records
  for each row execute function public.set_updated_at();

-- ---------- Row Level Security ----------
-- Enable RLS, then grant the operations the app currently needs to the anon
-- role. (Defense-in-depth — see SECURITY NOTE above.)
alter table public.records enable row level security;

-- Clean re-runs:
drop policy if exists records_anon_select on public.records;
drop policy if exists records_anon_insert on public.records;
drop policy if exists records_anon_update on public.records;
drop policy if exists records_anon_delete on public.records;

-- The internal app (anon key) reads/writes all collections it manages.
create policy records_anon_select on public.records
  for select to anon using (true);

create policy records_anon_insert on public.records
  for insert to anon with check (true);

create policy records_anon_update on public.records
  for update to anon using (true) with check (true);

create policy records_anon_delete on public.records
  for delete to anon using (true);

-- ============================================================================
-- BACKUPS
-- ----------------------------------------------------------------------------
-- 1) In-app: Magnet OS Backup Center keeps rolling in-browser snapshots and
--    can auto-download JSON backups (Settings -> Backup Center).
-- 2) Supabase: enable automatic daily backups in
--    Project Settings -> Database -> Backups (paid plans), or schedule a
--    periodic `pg_dump` / table export of public.records.
-- A one-row-per-record JSON export is enough to fully restore the app state.
-- ============================================================================

-- ---------- quick verification ----------
-- select count(*) as record_count from public.records;
-- select coll, count(*) from public.records group by coll order by 2 desc;
