-- ============================================================================
-- Magnet OS — read-only RLS/grant audit. Run in Supabase SQL Editor as an
-- authorized database administrator. It intentionally reports both the legacy
-- Stage-A policies and the target tenant lock-down state; it changes nothing.
-- ============================================================================

-- 1) RLS must be enabled on records.
select relname, relrowsecurity as rls_enabled
from pg_class where relname = 'records';

-- 2) Inspect every records policy. The legacy policies that only exclude
-- _accounts/_ratelimit are NOT SaaS-safe; private business collections must not
-- remain readable/writable by anon after the JWT/tenant cutover.
select polname,
       cmd,
       pg_get_expr(polqual,  polrelid)      as using_expr,
       pg_get_expr(polwithcheck, polrelid)  as check_expr
from pg_policy
where polrelid = 'public.records'::regclass
order by polname;
-- TARGET: no anon policy exposes private business collections and authenticated
-- policies include organization membership/capability checks.

-- 3) There must be NO fully-open "team access" policy left.
select count(*) as open_team_access_policies
from pg_policy
where polrelid = 'public.records'::regclass and polname = 'team access';
-- EXPECT: 0

-- 4) View security and grants. accounts_safe must use security_invoker and must
-- not be granted to anon/authenticated.
select c.relname,
       c.reloptions,
       has_table_privilege('anon', c.oid, 'select') as anon_can_select,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_select
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='accounts_safe';

-- 5) Migration audit trail.
select migration, applied_at, note from public.migration_audit order by applied_at;

-- 6) Simulate the anonymous database role. Any positive count below is a P0
-- until the mandatory JWT + tenant RLS rollout is complete.
begin;
set local role anon;
select coll, count(*) as anonymously_visible
from public.records
where coll in ('clients','employees','invoices','tasks','reports','leads')
group by coll
order by coll;
select count(*) as anonymously_visible_account_roster from public.accounts_safe;
rollback;

-- 7) Manual public-key probe (run with publishable key, NOT service_role):
--    _accounts  -> must be 401/403:
--      curl -s -o /dev/null -w "%{http_code}\n" \
--        "$SUPABASE_URL/rest/v1/records?select=id&coll=eq._accounts&limit=1" -H "apikey: $ANON_KEY"
--    clients    -> must return no private rows after the tenant cutover:
--      curl -s -o /dev/null -w "%{http_code}\n" \
--        "$SUPABASE_URL/rest/v1/records?select=id&coll=eq.clients&limit=1"    -H "apikey: $ANON_KEY"
