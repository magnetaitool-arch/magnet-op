-- Push live changes of public.records to subscribed clients (INSERT/UPDATE/DELETE).
-- REPLICA IDENTITY FULL so DELETE events include the `coll` (not just the id),
-- letting the app remove the record from the right collection instantly.
alter table public.records replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.records; exception when duplicate_object then null; end;
end $$;;
