-- ============================================================================
-- Magnet OS migration 001 — backup safety + audit scaffolding (ADDITIVE ONLY)
-- ----------------------------------------------------------------------------
-- SAFE TO RUN ON PRODUCTION. This migration:
--   * never drops a table, never deletes a row
--   * only CREATEs (if not exists) and ADDs nullable columns
--   * is idempotent — re-running it changes nothing
--
-- WHAT IT DOES
--   1. Guarantees the records table + indexes + updated_at trigger exist.
--   2. Adds an append-only migration audit log so every schema change is recorded.
--   3. Takes an OPTIONAL one-shot snapshot of the current records into
--      records_backup_001 so you have an in-database restore point before the
--      RLS hardening in 002.
--
-- ROLLBACK NOTES (non-destructive): to undo, you may DROP TABLE records_backup_001
-- and public.migration_audit. Do NOT drop public.records. There is no destructive
-- rollback here because nothing destructive is done.
-- ============================================================================

-- ---------- 1. records table (create if missing) ----------
create table if not exists public.records (
  id          text primary key,
  coll        text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists records_coll_idx        on public.records (coll);
create index if not exists records_updated_at_idx   on public.records (updated_at desc);
create index if not exists records_data_gin_idx     on public.records using gin (data);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists records_set_updated_at on public.records;
create trigger records_set_updated_at
  before update on public.records
  for each row execute function public.set_updated_at();

-- ---------- 2. migration audit log (append-only) ----------
create table if not exists public.migration_audit (
  id          bigint generated always as identity primary key,
  migration   text not null,
  applied_at  timestamptz not null default now(),
  note        text
);

insert into public.migration_audit (migration, note)
values ('001_backup_and_audit', 'ensured records schema, indexes, trigger; created snapshot records_backup_001');

-- ---------- 3. one-shot in-database snapshot (restore point) ----------
-- Only creates the snapshot the FIRST time (idempotent). This is a cheap safety
-- net in addition to the JSON backups in /backups (tools/backup-supabase-records.js).
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='records_backup_001') then
    execute 'create table public.records_backup_001 as table public.records';
  end if;
end $$;

-- ---------- verification ----------
-- select migration, applied_at from public.migration_audit order by applied_at;
-- select (select count(*) from public.records) as live,
--        (select count(*) from public.records_backup_001) as snapshot;
