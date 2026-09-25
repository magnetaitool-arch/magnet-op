-- Explicit finish-to-start prerequisites. Existing task fields/data are not rewritten.
begin;
create table public.task_dependencies_v2(
 organization_id uuid not null,task_id uuid not null,depends_on_task_id uuid not null,
 created_by uuid not null references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),removed_at timestamptz,
 primary key(organization_id,task_id,depends_on_task_id),check(task_id<>depends_on_task_id),
 foreign key(organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict,
 foreign key(organization_id,depends_on_task_id) references public.work_tasks(organization_id,id) on delete restrict
);
create index task_dependencies_reverse_idx on public.task_dependencies_v2(organization_id,depends_on_task_id) where removed_at is null;
create table public.task_dependency_commands_v2(
 organization_id uuid not null references public.organizations(id) on delete restrict,
 command_id uuid not null,actor_user_id uuid not null references public.profiles(id) on delete restrict,
 task_id uuid not null,depends_on_task_id uuid not null,action text not null check(action in('ADD','REMOVE')),
 created_at timestamptz not null default now(),primary key(organization_id,command_id),
 foreign key(organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict,
 foreign key(organization_id,depends_on_task_id) references public.work_tasks(organization_id,id) on delete restrict
);
alter table public.task_dependencies_v2 enable row level security;
alter table public.task_dependency_commands_v2 enable row level security;
revoke all on public.task_dependencies_v2,public.task_dependency_commands_v2 from public,anon,authenticated;
grant select,insert,update on public.task_dependencies_v2 to service_role;
grant select,insert on public.task_dependency_commands_v2 to service_role;
create or replace function public.get_task_dependencies_v2(p_organization_id uuid,p_task_id uuid,p_search text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare task public.work_tasks%rowtype;items jsonb;candidates jsonb;blocked integer;
begin
 select * into task from public.work_tasks where organization_id=p_organization_id and id=p_task_id and deleted_at is null;
 if task.id is null or not public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible) or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='task_access_required';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'title',case when public.can_read_task_v2(p.organization_id,p.legacy_client_id,p.assigned_user_id,p.assigned_employee_record_id,p.client_visible) then p.title else null end,'done',p.status='Done' and p.deleted_at is null,'unavailable',p.deleted_at is not null) order by d.created_at),'[]'::jsonb),count(*) filter(where p.status<>'Done' or p.deleted_at is not null) into items,blocked
 from public.task_dependencies_v2 d join public.work_tasks p on p.id=d.depends_on_task_id and p.organization_id=d.organization_id where d.organization_id=p_organization_id and d.task_id=p_task_id and d.removed_at is null;
 if public.has_org_capability(p_organization_id,'work.manage') then
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'title',q.title,'status',q.status) order by q.title,q.id),'[]'::jsonb) into candidates from(
   select p.id,p.title,p.status from public.work_tasks p where p.organization_id=p_organization_id and p.project_reference_id=task.project_reference_id and p.client_account_id=task.client_account_id and p.id<>p_task_id and p.deleted_at is null and p.status<>'Cancelled'
    and (nullif(btrim(p_search),'') is null or p.title ilike '%'||left(btrim(p_search),100)||'%' or p.task_code ilike '%'||left(btrim(p_search),100)||'%')
    and not exists(select 1 from public.task_dependencies_v2 d where d.organization_id=p_organization_id and d.task_id=p_task_id and d.depends_on_task_id=p.id and d.removed_at is null)
   order by p.title,p.id limit 100
  )q;
 end if;
 return jsonb_build_object('ok',true,'taskId',task.id,'status',task.status,'canManage',public.has_org_capability(p_organization_id,'work.manage'),'canAdd',public.has_org_capability(p_organization_id,'work.manage') and task.status in('Backlog','To Do','Blocked'),'blockedCount',blocked,'items',items,'candidates',coalesce(candidates,'[]'::jsonb));
end;$$;
create or replace function public.set_task_dependency_v2(p_organization_id uuid,p_task_id uuid,p_depends_on_task_id uuid,p_action text,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.work_tasks%rowtype;prerequisite public.work_tasks%rowtype;prior public.task_dependency_commands_v2%rowtype;changed boolean:=false;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'work.manage') or not public.has_org_capability(p_organization_id,'work.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='task_manage_required';end if;
 if p_command_id is null or p_action is null or p_action not in('ADD','REMOVE') or p_task_id is null or p_depends_on_task_id is null or p_task_id=p_depends_on_task_id then raise exception 'task_dependency_request_invalid';end if;
 perform pg_advisory_xact_lock(hashtextextended('task-dependencies:'||p_organization_id::text,0));
 select * into task from public.work_tasks where organization_id=p_organization_id and id=p_task_id and deleted_at is null;
 select * into prerequisite from public.work_tasks where organization_id=p_organization_id and id=p_depends_on_task_id;
 if task.id is null or prerequisite.id is null then raise exception 'task_dependency_unavailable';end if;
 select * into prior from public.task_dependency_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then
  if prior.actor_user_id<>auth.uid() or prior.task_id<>p_task_id or prior.depends_on_task_id<>p_depends_on_task_id or prior.action<>p_action then raise exception 'idempotency_conflict';end if;
  return public.get_task_dependencies_v2(p_organization_id,p_task_id)||jsonb_build_object('replayed',true);
 end if;
 if p_action='ADD' then
  if task.status not in('Backlog','To Do','Blocked') then raise exception 'pause_task_before_dependency_change';end if;
  if prerequisite.deleted_at is not null or prerequisite.status='Cancelled' or task.project_reference_id is null or prerequisite.project_reference_id is distinct from task.project_reference_id or prerequisite.client_account_id is distinct from task.client_account_id then raise exception 'task_dependency_project_mismatch';end if;
  if exists(with recursive ancestors(id) as(select p_depends_on_task_id union select d.depends_on_task_id from public.task_dependencies_v2 d join ancestors a on d.task_id=a.id where d.organization_id=p_organization_id and d.removed_at is null)select 1 from ancestors where id=p_task_id) then raise exception 'task_dependency_cycle';end if;
  insert into public.task_dependencies_v2(organization_id,task_id,depends_on_task_id,created_by) values(p_organization_id,p_task_id,p_depends_on_task_id,auth.uid()) on conflict(organization_id,task_id,depends_on_task_id) do update set removed_at=null,created_by=auth.uid(),created_at=now() where public.task_dependencies_v2.removed_at is not null;
  changed=found;
 else
  update public.task_dependencies_v2 set removed_at=now() where organization_id=p_organization_id and task_id=p_task_id and depends_on_task_id=p_depends_on_task_id and removed_at is null;
  changed=found;
 end if;
 if changed then
  insert into public.task_events_v2(organization_id,task_id,action,note,actor_user_id,safe_context) values(p_organization_id,p_task_id,'UPDATED',case when p_action='ADD' then 'Prerequisite added' else 'Prerequisite removed' end,auth.uid(),jsonb_build_object('kind','DEPENDENCY_'||p_action,'prerequisiteId',p_depends_on_task_id));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'TASK_DEPENDENCY_'||p_action,'task',p_task_id::text,jsonb_build_object('prerequisiteId',p_depends_on_task_id,'commandId',p_command_id));
 end if;
 insert into public.task_dependency_commands_v2 values(p_organization_id,p_command_id,auth.uid(),p_task_id,p_depends_on_task_id,p_action,now());
 return public.get_task_dependencies_v2(p_organization_id,p_task_id)||jsonb_build_object('replayed',false);
end;$$;
create or replace function public.guard_task_dependencies_v2()
returns trigger language plpgsql security definer set search_path='' as $$
declare resolved_task_id uuid;
begin
 if old.coll<>'tasks' then return new;end if;
 if new.data->'status' is not distinct from old.data->'status' and new.data->'projectId' is not distinct from old.data->'projectId' and new.data->'clientId' is not distinct from old.data->'clientId' then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('task-dependencies:'||old.organization_id::text,0));
 select id into resolved_task_id from public.work_tasks where organization_id=old.organization_id and legacy_record_id=old.id;
 if resolved_task_id is null then return new;end if;
 if (new.data->'projectId',new.data->'clientId') is distinct from (old.data->'projectId',old.data->'clientId') and exists(select 1 from public.task_dependencies_v2 d where d.organization_id=old.organization_id and (d.task_id=resolved_task_id or d.depends_on_task_id=resolved_task_id) and d.removed_at is null) then raise exception 'task_dependency_relationship_locked';end if;
 if new.data->'status' is distinct from old.data->'status' and new.data->>'status' in('In Progress','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done') and exists(select 1 from public.task_dependencies_v2 d join public.work_tasks p on p.organization_id=d.organization_id and p.id=d.depends_on_task_id where d.organization_id=old.organization_id and d.task_id=resolved_task_id and d.removed_at is null and (p.status<>'Done' or p.deleted_at is not null)) then raise exception 'task_dependencies_incomplete';end if;
 if old.data->>'status'='Done' and new.data->>'status'<>'Done' and exists(select 1 from public.task_dependencies_v2 d join public.work_tasks child on child.organization_id=d.organization_id and child.id=d.task_id where d.organization_id=old.organization_id and d.depends_on_task_id=resolved_task_id and d.removed_at is null and child.deleted_at is null and child.status not in('Backlog','To Do','Blocked','Cancelled')) then raise exception 'pause_dependent_tasks_before_reopening';end if;
 return new;
end;$$;
create trigger task_dependency_authority before update on public.records for each row execute function public.guard_task_dependencies_v2();
revoke all on function public.guard_task_dependencies_v2() from public,anon,authenticated;
revoke all on function public.get_task_dependencies_v2(uuid,uuid,text),public.set_task_dependency_v2(uuid,uuid,uuid,text,uuid) from public,anon;
grant execute on function public.get_task_dependencies_v2(uuid,uuid,text),public.set_task_dependency_v2(uuid,uuid,uuid,text,uuid) to authenticated;
commit;
-- Rollback task actions to read-only; retain dependencies, tombstones and history.
