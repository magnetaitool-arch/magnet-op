do $$
declare r record;
begin
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('current_role','handle_new_user','has_scope')
  loop
    begin execute format('revoke all on function public.%I(%s) from public, anon, authenticated', r.proname, r.args); exception when others then null; end;
  end loop;
end $$;;
