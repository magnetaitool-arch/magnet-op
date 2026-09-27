-- Assigned Studio staff may reference their task client's campaign without general CRM access.
-- Changes only two function predicates; no business rows or RLS policies are changed.
-- Rollback: restore the previous function definitions; retain all documents and versions.
begin;
DO $migration$
declare definition text; old_predicate text; new_predicate text;
begin
 old_predicate := 'r.deleted_at is null and public.records_can_read(r.organization_id,r.coll,r.data)';
 new_predicate := 'r.deleted_at is null and exists(select 1 from public.work_tasks ct where ct.organization_id=r.organization_id and ct.legacy_client_id=r.data->>''clientId'' and public.studio_task_access_v2(ct.organization_id,ct.id))';
 select pg_get_functiondef('public.list_studio_v2(uuid)'::regprocedure) into definition;
 if position(old_predicate in definition)=0 then raise exception 'Unexpected Studio list definition'; end if;
 execute replace(definition,old_predicate,new_predicate);
 old_predicate := 'r.data->>''clientId''=t.legacy_client_id and public.records_can_read(r.organization_id,r.coll,r.data)';
 new_predicate := 'r.data->>''clientId''=t.legacy_client_id and public.studio_task_access_v2(t.organization_id,t.id)';
 select pg_get_functiondef('public.studio_command_v2(uuid,uuid,uuid,text,text,integer,text,jsonb,uuid,text,uuid)'::regprocedure) into definition;
 if position(old_predicate in definition)=0 then raise exception 'Unexpected Studio command definition'; end if;
 execute replace(definition,old_predicate,new_predicate);
end $migration$;
commit;
