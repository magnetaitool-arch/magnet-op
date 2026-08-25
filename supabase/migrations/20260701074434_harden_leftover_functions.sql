-- Lock down leftover SECURITY DEFINER functions (remnants of an old auth attempt,
-- unused by the app) and pin their search_path. Wrapped so unknown signatures are ignored.
do $$
declare r record;
begin
  for r in
    select p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('current_role','handle_new_user','has_scope','is_staff','touch_updated','touch_updated_at')
  loop
    begin execute format('revoke execute on function public.%I(%s) from anon, authenticated', r.proname, r.args); exception when others then null; end;
    begin execute format('alter function public.%I(%s) set search_path = public', r.proname, r.args); exception when others then null; end;
  end loop;
end $$;;
