-- Magnet OS P0 — stop the sanitized legacy account roster from bypassing RLS.
--
-- Production evidence on 2026-08-16 showed that the publishable/anon key could
-- SELECT public.accounts_safe even though the underlying _accounts rows were
-- hidden by records RLS. PostgreSQL views use the view owner's privileges unless
-- security_invoker is enabled, and migration 003 did not revoke API grants.
--
-- This migration is narrow and non-destructive. The application does not query
-- this view; account administration uses the accounts Edge Function.

begin;

do $$
begin
  if to_regclass('public.accounts_safe') is null then
    raise exception 'public.accounts_safe is missing; migration aborted';
  end if;
end $$;

alter view public.accounts_safe set (security_invoker = true);

revoke all privileges on public.accounts_safe from public;
revoke all privileges on public.accounts_safe from anon;
revoke all privileges on public.accounts_safe from authenticated;
grant select on public.accounts_safe to service_role;

insert into public.migration_audit (migration, note)
select
  '20260816060242_harden_accounts_safe_view',
  'Enabled security_invoker and revoked public/anon/authenticated access to the sanitized legacy account roster.'
where not exists (
  select 1
  from public.migration_audit
  where migration = '20260816060242_harden_accounts_safe_view'
);

commit;

-- Verification with the publishable key must return no rows / permission denied:
--   GET /rest/v1/accounts_safe?select=id&limit=1
-- Service-role verification must still return sanitized rows and no passwordHash.
--
-- Rollback policy: do not re-grant this view to anon/authenticated. If a trusted
-- admin consumer is discovered, expose it through an authenticated capability-
-- checked server endpoint instead of restoring the privacy leak.
