-- Magnet OS — migrations 001→004 (additive + idempotent; nothing dropped/deleted)
-- User explicitly approved applying these to production (2026-07-11).

-- ==== 001: records schema guarantees + audit log + one-shot snapshot ====
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

create table if not exists public.migration_audit (
  id          bigint generated always as identity primary key,
  migration   text not null,
  applied_at  timestamptz not null default now(),
  note        text
);
insert into public.migration_audit (migration, note)
values ('001_backup_and_audit', 'ensured records schema, indexes, trigger; created snapshot records_backup_001');

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='records_backup_001') then
    execute 'create table public.records_backup_001 as table public.records';
  end if;
end $$;

-- ==== 002: RLS hardening — anon blocked from _accounts + _ratelimit ====
alter table public.records enable row level security;
drop policy if exists "team access"        on public.records;
drop policy if exists records_anon_select   on public.records;
drop policy if exists records_anon_insert   on public.records;
drop policy if exists records_anon_update   on public.records;
drop policy if exists records_anon_delete   on public.records;
drop policy if exists records_anon_public_read   on public.records;
drop policy if exists records_anon_public_insert on public.records;

create policy records_anon_select on public.records
  for select to anon using      (coll not in ('_accounts','_ratelimit'));
create policy records_anon_insert on public.records
  for insert to anon with check (coll not in ('_accounts','_ratelimit'));
create policy records_anon_update on public.records
  for update to anon using      (coll not in ('_accounts','_ratelimit')) with check (coll not in ('_accounts','_ratelimit'));
create policy records_anon_delete on public.records
  for delete to anon using      (coll not in ('_accounts','_ratelimit'));

do $$ begin
  begin revoke execute on function public.current_role()   from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.handle_new_user() from anon, authenticated; exception when undefined_function then null; end;
  begin revoke execute on function public.has_scope(text)   from anon, authenticated; exception when undefined_function then null; end;
end $$;

insert into public.migration_audit (migration, note)
values ('002_records_rls_hardening', 'anon blocked from _accounts + _ratelimit (select/insert/update/delete); revoked leftover definer funcs');

-- ==== 003: hash-free accounts view + server stamp trigger ====
create or replace view public.accounts_safe as
select
  id,
  (data - 'passwordHash' - 'verifyToken') as data,
  updated_at
from public.records
where coll = '_accounts';
comment on view public.accounts_safe is
  'Hash-free account roster (passwordHash/verifyToken stripped). Never expose password hashes to clients.';

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

-- ==== 004: sync metadata + soft-delete columns + backfill + indexes ====
alter table public.records add column if not exists created_at timestamptz;
alter table public.records add column if not exists created_by text;
alter table public.records add column if not exists updated_by text;
alter table public.records add column if not exists deleted_at timestamptz;

create or replace function public.try_ts(t text)
returns timestamptz language plpgsql immutable as $$
begin
  return t::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function public.fill_sync_meta()
returns trigger language plpgsql as $$
begin
  if new.created_at is null then
    new.created_at := coalesce(public.try_ts(new.data->>'createdAt'), now());
  end if;
  new.created_by := coalesce(new.data->>'createdBy', new.created_by);
  new.updated_by := coalesce(new.data->>'updatedBy', new.data->>'lastEditedBy', new.updated_by);
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

update public.records set
  created_at = coalesce(created_at, public.try_ts(data->>'createdAt'), updated_at),
  created_by = coalesce(created_by, data->>'createdBy'),
  updated_by = coalesce(updated_by, data->>'updatedBy', data->>'lastEditedBy'),
  deleted_at = case when lower(coalesce(data->>'_del','')) in ('true','1','t') then coalesce(deleted_at, updated_at) else null end
where created_at is null
   or (deleted_at is null and lower(coalesce(data->>'_del','')) in ('true','1','t'));

create index if not exists records_created_at_idx on public.records (created_at desc);
create index if not exists records_deleted_at_idx on public.records (deleted_at) where deleted_at is not null;
create index if not exists records_coll_updated_idx on public.records (coll, updated_at desc);

insert into public.migration_audit (migration, note)
values ('004_activity_and_sync_metadata', 'added created_at/created_by/updated_by/deleted_at columns + fill trigger + indexes; backfilled');;
