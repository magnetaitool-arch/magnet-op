-- Ordered prerequisite for employee_requests_v3's legacy audit marker.
-- The hosted legacy database may not have public.schema_migrations. The actual
-- migration authority remains supabase_migrations.schema_migrations.
-- Created with the CLI, ordered immediately before its existing dependent file;
-- no previously applied migration is edited. No business rows are changed.
begin;
create table if not exists public.schema_migrations (
  version text primary key,
  description text,
  applied_by text
);
alter table public.schema_migrations enable row level security;
revoke all on table public.schema_migrations from public, anon, authenticated;
commit;
