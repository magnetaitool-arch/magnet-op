-- ============================================================================
-- Magnet OS — RLS verification. Run in Supabase SQL Editor (service_role context).
-- Confirms the 002 hardening is in place. Read-only; changes nothing.
-- ============================================================================

-- 1) RLS must be enabled on records.
select relname, relrowsecurity as rls_enabled
from pg_class where relname = 'records';

-- 2) The four anon policies must all be scoped to  coll <> '_accounts'.
select polname,
       cmd,
       pg_get_expr(polqual,  polrelid)      as using_expr,
       pg_get_expr(polwithcheck, polrelid)  as check_expr
from pg_policy
where polrelid = 'public.records'::regclass
order by polname;
-- EXPECT: every row mentions (coll <> '_accounts'::text). No policy should be `true`.

-- 3) There must be NO fully-open "team access" policy left.
select count(*) as open_team_access_policies
from pg_policy
where polrelid = 'public.records'::regclass and polname = 'team access';
-- EXPECT: 0

-- 4) Migration audit trail.
select migration, applied_at, note from public.migration_audit order by applied_at;

-- 5) Manual anon probe (run these with the ANON key, NOT service_role — e.g. curl):
--    _accounts  -> must be 401/403:
--      curl -s -o /dev/null -w "%{http_code}\n" \
--        "$SUPABASE_URL/rest/v1/records?select=id&coll=eq._accounts&limit=1" -H "apikey: $ANON_KEY"
--    clients    -> must be 200:
--      curl -s -o /dev/null -w "%{http_code}\n" \
--        "$SUPABASE_URL/rest/v1/records?select=id&coll=eq.clients&limit=1"    -H "apikey: $ANON_KEY"
