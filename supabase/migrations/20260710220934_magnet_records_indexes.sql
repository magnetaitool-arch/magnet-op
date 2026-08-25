-- Safe, decision-independent: indexes that make per-module server-side loading fast.
create index if not exists records_coll_idx          on public.records (coll);
create index if not exists records_coll_client_idx   on public.records (coll, (data->>'clientId'));
create index if not exists records_coll_assigned_idx on public.records (coll, (data->>'assignedTo'));
create index if not exists records_coll_created_idx  on public.records (coll, (data->>'createdAt'));;
