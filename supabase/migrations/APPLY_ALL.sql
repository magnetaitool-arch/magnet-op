-- ============================================================================
-- RETIRED BUNDLE — historical migrations 001→004 only.
--
-- DO NOT use this file to provision or upgrade Magnet OS. It omits later repair,
-- privacy, and SaaS foundation migrations and can create dangerous schema drift.
-- Use the Supabase CLI migration workflow against supabase/migrations/ after a
-- verified backup and staging restore. This bundle remains only as history.
-- ============================================================================


-- ####################  001_backup_and_audit.sql  ####################

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

-- ####################  002_records_rls_hardening.sql  ####################

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

-- anon may read/write EVERY collection EXCEPT the server-only ones:
--   _accounts   — password hashes (must never reach the browser)
--   _ratelimit  — brute-force counters (anon must not clear its own limiter)
-- Both are reachable only through the service_role Edge Function (bypasses RLS).
create policy records_anon_select on public.records
  for select to anon using      (coll not in ('_accounts','_ratelimit'));
create policy records_anon_insert on public.records
  for insert to anon with check (coll not in ('_accounts','_ratelimit'));
create policy records_anon_update on public.records
  for update to anon using      (coll not in ('_accounts','_ratelimit')) with check (coll not in ('_accounts','_ratelimit'));
create policy records_anon_delete on public.records
  for delete to anon using      (coll not in ('_accounts','_ratelimit'));

-- Remove leftover SECURITY DEFINER functions callable by anon (advisor findings
-- from an earlier Auth attempt; the app does not use them).
do $$ begin
  begin revoke execute on function public.current_role()   from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.handle_new_user() from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.has_scope(text)   from anon, authenticated; exception when undefined_function then null; end;
end $$;

insert into public.migration_audit (migration, note)
values ('002_records_rls_hardening', 'anon blocked from _accounts + _ratelimit (select/insert/update/delete); revoked leftover definer funcs');

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

-- ####################  003_accounts_security.sql  ####################

-- ============================================================================
-- Magnet OS migration 003 — accounts hardening helpers. ADDITIVE, non-destructive.
-- ----------------------------------------------------------------------------
-- Depends on 002 (which blocks anon from _accounts). This migration adds
-- server-side conveniences that NEVER expose password hashes:
--   * a sanitized, hash-free view of accounts for service-role reporting
--   * a guard trigger that stamps account rows with a server timestamp
-- It does NOT change how the app or the Edge Function work; both keep using the
-- records table directly. Safe to run before or after the app update.
--
-- ROLLBACK (non-destructive):
--   drop view if exists public.accounts_safe;
--   drop trigger if exists records_accounts_stamp on public.records;
--   drop function if exists public.stamp_account_row();
-- ============================================================================

-- Sanitized view: account roster WITHOUT passwordHash / verifyToken. Only the
-- service_role (or a future authenticated admin) should query this; anon RLS on
-- the base table still blocks anon regardless.
create or replace view public.accounts_safe as
select
  id,
  (data - 'passwordHash' - 'verifyToken') as data,
  updated_at
from public.records
where coll = '_accounts';

comment on view public.accounts_safe is
  'Hash-free account roster (passwordHash/verifyToken stripped). Never expose password hashes to clients.';

-- Guard trigger: whenever an _accounts row is written, record a server-side
-- timestamp inside data.serverUpdatedAt (tamper-evident vs the client-supplied
-- updatedAt). Purely additive — does not reject or alter the payload otherwise.
create or replace function public.stamp_account_row()
returns trigger language plpgsql as $$
begin
  if new.coll = '_accounts' then
    new.data = jsonb_set(coalesce(new.data,'{}'::jsonb), '{serverUpdatedAt}', to_jsonb(now()::text), true);
  end if;
  return new;
end;
$$;

drop trigger if exists records_accounts_stamp on public.records;
create trigger records_accounts_stamp
  before insert or update on public.records
  for each row execute function public.stamp_account_row();

insert into public.migration_audit (migration, note)
values ('003_accounts_security', 'added accounts_safe view (hash-free) + server-side account stamp trigger');

-- ---------- verification ----------
-- select count(*) from public.accounts_safe;                 -- roster size, no hashes
-- select data ? 'passwordHash' as leaks_hash from public.accounts_safe limit 1;  -- must be false

-- ####################  004_activity_and_sync_metadata.sql  ####################

-- ============================================================================
-- Magnet OS migration 004 — sync metadata + soft-delete + activity. ADDITIVE.
-- ----------------------------------------------------------------------------
-- SAFE ON PRODUCTION. Adds nullable columns and indexes derived from the existing
-- JSONB `data`, so the app keeps working unchanged (it still only writes id/coll/
-- data). These columns let you query audit/sync info in SQL without unpacking JSON,
-- and give a real deleted_at for soft-delete reporting.
--
-- The app already tombstones deletes with data->>'_del' = true and timestamps with
-- data->>'updatedAt' / 'createdAt'. This migration surfaces those as columns.
--
-- ROLLBACK (non-destructive): drop the added columns/indexes and the trigger:
--   drop trigger if exists records_sync_meta on public.records;
--   drop function if exists public.fill_sync_meta();
--   drop function if exists public.try_ts(text);
--   alter table public.records drop column if exists created_at,
--     drop column if exists created_by, drop column if exists updated_by,
--     drop column if exists deleted_at;
-- ============================================================================

-- ---------- 1. audit / sync columns (nullable, additive) ----------
alter table public.records add column if not exists created_at timestamptz;
alter table public.records add column if not exists created_by text;
alter table public.records add column if not exists updated_by text;
alter table public.records add column if not exists deleted_at timestamptz;  -- soft delete (never physically drop)

-- ---------- 2. safe timestamp cast ----------
-- One malformed data->>'createdAt' string must NEVER abort a write or the
-- backfill, so all casts go through this exception-safe helper.
create or replace function public.try_ts(t text)
returns timestamptz language plpgsql immutable as $$
begin
  return t::timestamptz;
exception when others then
  return null;
end;
$$;

-- ---------- 3. trigger to fill the columns from the JSON payload ----------
create or replace function public.fill_sync_meta()
returns trigger language plpgsql as $$
begin
  -- created_at: from data.createdAt on first write, then preserved.
  if new.created_at is null then
    new.created_at := coalesce(public.try_ts(new.data->>'createdAt'), now());
  end if;
  new.created_by := coalesce(new.data->>'createdBy', new.created_by);
  new.updated_by := coalesce(new.data->>'updatedBy', new.data->>'lastEditedBy', new.updated_by);
  -- soft delete: tombstoned records (data._del = true) get a deleted_at stamp;
  -- the row is KEPT so the delete can propagate without losing history.
  -- (text comparison, not a ::boolean cast, so junk values can't abort writes)
  if lower(coalesce(new.data->>'_del','')) in ('true','1','t') then
    new.deleted_at := coalesce(new.deleted_at, now());
  else
    new.deleted_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists records_sync_meta on public.records;
create trigger records_sync_meta
  before insert or update on public.records
  for each row execute function public.fill_sync_meta();

-- ---------- 4. backfill existing rows once (idempotent, cast-safe) ----------
update public.records set
  created_at = coalesce(created_at, public.try_ts(data->>'createdAt'), updated_at),
  created_by = coalesce(created_by, data->>'createdBy'),
  updated_by = coalesce(updated_by, data->>'updatedBy', data->>'lastEditedBy'),
  deleted_at = case when lower(coalesce(data->>'_del','')) in ('true','1','t') then coalesce(deleted_at, updated_at) else null end
where created_at is null
   or (deleted_at is null and lower(coalesce(data->>'_del','')) in ('true','1','t'));

-- ---------- 5. indexes for the new access paths ----------
create index if not exists records_created_at_idx on public.records (created_at desc);
create index if not exists records_deleted_at_idx on public.records (deleted_at) where deleted_at is not null;
create index if not exists records_coll_updated_idx on public.records (coll, updated_at desc);

insert into public.migration_audit (migration, note)
values ('004_activity_and_sync_metadata', 'added created_at/created_by/updated_by/deleted_at columns + fill trigger + indexes; backfilled');

-- ---------- verification ----------
-- select coll, count(*) filter (where deleted_at is not null) as soft_deleted,
--        count(*) as total from public.records group by coll order by 3 desc;
