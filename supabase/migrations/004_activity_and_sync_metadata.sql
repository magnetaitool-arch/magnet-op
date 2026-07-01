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
--   alter table public.records drop column if exists created_at,
--     drop column if exists created_by, drop column if exists updated_by,
--     drop column if exists deleted_at;
-- ============================================================================

-- ---------- 1. audit / sync columns (nullable, additive) ----------
alter table public.records add column if not exists created_at timestamptz;
alter table public.records add column if not exists created_by text;
alter table public.records add column if not exists updated_by text;
alter table public.records add column if not exists deleted_at timestamptz;  -- soft delete (never physically drop)

-- ---------- 2. trigger to fill them from the JSON payload ----------
create or replace function public.fill_sync_meta()
returns trigger language plpgsql as $$
begin
  -- created_at: from data.createdAt on first write, then preserved.
  if new.created_at is null then
    new.created_at := coalesce((new.data->>'createdAt')::timestamptz, now());
  end if;
  new.created_by := coalesce(new.data->>'createdBy', new.created_by);
  new.updated_by := coalesce(new.data->>'updatedBy', new.data->>'lastEditedBy', new.updated_by);
  -- soft delete: tombstoned records (data._del = true) get a deleted_at stamp;
  -- the row is KEPT so the delete can propagate without losing history.
  if coalesce((new.data->>'_del')::boolean, false) then
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

-- ---------- 3. backfill existing rows once (idempotent) ----------
update public.records set
  created_at = coalesce(created_at, (data->>'createdAt')::timestamptz, updated_at),
  created_by = coalesce(created_by, data->>'createdBy'),
  updated_by = coalesce(updated_by, data->>'updatedBy', data->>'lastEditedBy'),
  deleted_at = case when coalesce((data->>'_del')::boolean,false) then coalesce(deleted_at, updated_at) else null end
where created_at is null or (deleted_at is null and coalesce((data->>'_del')::boolean,false));

-- ---------- 4. indexes for the new access paths ----------
create index if not exists records_created_at_idx on public.records (created_at desc);
create index if not exists records_deleted_at_idx on public.records (deleted_at) where deleted_at is not null;
create index if not exists records_coll_updated_idx on public.records (coll, updated_at desc);

insert into public.migration_audit (migration, note)
values ('004_activity_and_sync_metadata', 'added created_at/created_by/updated_by/deleted_at columns + fill trigger + indexes; backfilled');

-- ---------- verification ----------
-- select coll, count(*) filter (where deleted_at is not null) as soft_deleted,
--        count(*) as total from public.records group by coll order by 3 desc;
