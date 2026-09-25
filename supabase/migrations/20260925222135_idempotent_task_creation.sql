-- Retried interactive creates commit one task, assignment notification and event.
begin;
create table public.task_create_commands_v2(
 organization_id uuid not null references public.organizations(id) on delete restrict,
 command_id uuid not null,actor_user_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,task_id uuid not null,created_at timestamptz not null default now(),
 primary key(organization_id,command_id),
 foreign key(organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict
);
alter table public.task_create_commands_v2 enable row level security;
revoke all on public.task_create_commands_v2 from public,anon,authenticated;
grant select,insert on public.task_create_commands_v2 to service_role;
create or replace function public.create_task_v2(
  p_organization_id uuid,p_title text,p_client_account_id uuid,p_project_record_id text,p_assigned_employee_record_id text,
  p_status text default 'Backlog',p_priority text default 'Normal',p_task_type text default null,p_start_date date default null,
  p_due_date date default null,p_estimated_hours numeric default 0,p_brief text default null,p_requirements text default null,
  p_reference_links text default null,p_client_visible boolean default false
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare client_row public.client_accounts%rowtype; declare assigned_uuid uuid; declare legacy_id text:='tsk-'||replace(gen_random_uuid()::text,'-',''); declare task_uuid uuid; declare task_data jsonb;
begin
  if not public.has_org_capability(p_organization_id,'work.manage') then raise exception using errcode='42501',message='work_manage_required'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then raise exception 'invalid_task_title'; end if;
  if coalesce(p_status,'Backlog') not in ('Backlog','To Do','In Progress','Waiting for Client','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled') then raise exception 'invalid_task_status'; end if;
  if coalesce(p_priority,'Normal') not in ('Low','Normal','Medium','High','Urgent') then raise exception 'invalid_task_priority'; end if;
  if p_due_date is not null and p_start_date is not null and p_due_date<p_start_date then raise exception 'invalid_task_dates'; end if;
  select * into client_row from public.client_accounts client where client.organization_id=p_organization_id and client.id=p_client_account_id and client.deleted_at is null;
  if client_row.id is null then raise exception using errcode='23503',message='task_client_not_found'; end if;
  if not exists(select 1 from public.records project where project.organization_id=p_organization_id and project.id=p_project_record_id and project.coll='projects' and project.deleted_at is null and project.data->>'clientId'=client_row.legacy_record_id) then raise exception using errcode='23503',message='task_project_client_mismatch'; end if;
  if not exists(select 1 from public.records employee where employee.organization_id=p_organization_id and employee.id=p_assigned_employee_record_id and employee.coll='employees' and employee.deleted_at is null) then raise exception using errcode='23503',message='task_assignee_not_found'; end if;
  assigned_uuid:=public.task_user_for_employee_v2(p_assigned_employee_record_id);
  if assigned_uuid is null or not exists(select 1 from public.organization_members m join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where m.organization_id=p_organization_id and m.user_id=assigned_uuid and m.status='ACTIVE') then raise exception 'task_assignee_review_required';end if;
  if p_estimated_hours is not null and (p_estimated_hours::text in('NaN','Infinity','-Infinity') or p_estimated_hours<0 or p_estimated_hours>10000 or p_estimated_hours<>round(p_estimated_hours,2)) then raise exception 'task_hours_invalid';end if;
  if (p_start_date is not null and not isfinite(p_start_date)) or (p_due_date is not null and not isfinite(p_due_date)) then raise exception 'task_dates_invalid';end if;

  task_data:=jsonb_build_object('id',legacy_id,'taskCode','TSK-'||upper(left(replace(legacy_id,'tsk-',''),8)),'title',btrim(p_title),
    'clientId',client_row.legacy_record_id,'projectId',p_project_record_id,'assignedTo',p_assigned_employee_record_id,
    'createdBy',auth.uid(),'status',coalesce(p_status,'Backlog'),'priority',coalesce(p_priority,'Normal'),'taskType',coalesce(p_task_type,''),
    'startDate',coalesce(p_start_date::text,''),'dueDate',coalesce(p_due_date::text,''),'estimatedHours',greatest(0,coalesce(p_estimated_hours,0)),
    'brief',coalesce(p_brief,''),'requirements',coalesce(p_requirements,''),'referenceLinks',coalesce(p_reference_links,''),
    'clientVisible',coalesce(p_client_visible,false),'createdAt',now(),'updatedAt',now());
  insert into public.records(id,coll,data,organization_id) values(legacy_id,'tasks',task_data,p_organization_id);
  select id into task_uuid from public.work_tasks where organization_id=p_organization_id and legacy_record_id=legacy_id;
  insert into public.task_events_v2(organization_id,task_id,action,to_status,note,actor_user_id) values(p_organization_id,task_uuid,'CREATED',coalesce(p_status,'Backlog'),'Task created',auth.uid());
  if assigned_uuid is not null then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(p_organization_id,assigned_uuid,'TASK_ASSIGNED','INFO','New task assigned',btrim(p_title),'tasks','tasks',task_uuid::text,'task-assigned:'||task_uuid::text||':1') on conflict do nothing;
  end if;
  return public.get_task_v2(p_organization_id,task_uuid);
end;
$$;

create or replace function public.update_task_v2(
  p_organization_id uuid,p_task_id uuid,p_expected_version integer,p_title text,p_client_account_id uuid,
  p_project_record_id text,p_assigned_employee_record_id text,p_priority text,p_task_type text,p_start_date date,p_due_date date,
  p_estimated_hours numeric,p_brief text,p_requirements text,p_reference_links text,p_delivery_link text,p_blockers text,p_client_visible boolean
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare client_row public.client_accounts%rowtype; declare assigned_uuid uuid;
begin
  if not public.has_org_capability(p_organization_id,'work.manage') then raise exception using errcode='42501',message='work_manage_required'; end if;
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null for update;
  if task_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if task_row.version<>p_expected_version then raise exception using errcode='40001',message='task_version_conflict'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then raise exception 'invalid_task_title'; end if;
  if p_priority not in ('Low','Normal','Medium','High','Urgent') then raise exception 'invalid_task_priority'; end if;
  if p_due_date is not null and p_start_date is not null and p_due_date<p_start_date then raise exception 'invalid_task_dates'; end if;
  select * into client_row from public.client_accounts client where client.organization_id=p_organization_id and client.id=p_client_account_id and client.deleted_at is null;
  if client_row.id is null then raise exception using errcode='23503',message='task_client_not_found'; end if;
  if not exists(select 1 from public.records project where project.organization_id=p_organization_id and project.id=p_project_record_id and project.coll='projects' and project.deleted_at is null and project.data->>'clientId'=client_row.legacy_record_id) then raise exception using errcode='23503',message='task_project_client_mismatch'; end if;
  if not exists(select 1 from public.records employee where employee.organization_id=p_organization_id and employee.id=p_assigned_employee_record_id and employee.coll='employees' and employee.deleted_at is null) then raise exception using errcode='23503',message='task_assignee_not_found'; end if;
  assigned_uuid:=public.task_user_for_employee_v2(p_assigned_employee_record_id);
  if assigned_uuid is null or not exists(select 1 from public.organization_members m join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where m.organization_id=p_organization_id and m.user_id=assigned_uuid and m.status='ACTIVE') then raise exception 'task_assignee_review_required';end if;
  if p_estimated_hours is not null and (p_estimated_hours::text in('NaN','Infinity','-Infinity') or p_estimated_hours<0 or p_estimated_hours>10000 or p_estimated_hours<>round(p_estimated_hours,2)) then raise exception 'task_hours_invalid';end if;
  if (p_start_date is not null and not isfinite(p_start_date)) or (p_due_date is not null and not isfinite(p_due_date)) then raise exception 'task_dates_invalid';end if;

  update public.records set data=data||jsonb_build_object('title',btrim(p_title),'name',btrim(p_title),'clientId',client_row.legacy_record_id,
    'projectId',p_project_record_id,'assignedTo',p_assigned_employee_record_id,'priority',p_priority,'taskType',coalesce(p_task_type,''),
    'startDate',coalesce(p_start_date::text,''),'dueDate',coalesce(p_due_date::text,''),'estimatedHours',greatest(0,coalesce(p_estimated_hours,0)),
    'brief',coalesce(p_brief,''),'requirements',coalesce(p_requirements,''),'referenceLinks',coalesce(p_reference_links,''),
    'deliveryLink',coalesce(p_delivery_link,''),'blockers',coalesce(p_blockers,''),'clientVisible',coalesce(p_client_visible,false),'updatedAt',now()),updated_at=now()
  where organization_id=p_organization_id and id=task_row.legacy_record_id;
  insert into public.task_events_v2(organization_id,task_id,action,note,actor_user_id,safe_context)
  values(p_organization_id,p_task_id,'UPDATED','Task details updated',auth.uid(),jsonb_build_object('assigneeChanged',task_row.assigned_employee_record_id is distinct from p_assigned_employee_record_id));
  if assigned_uuid is not null and task_row.assigned_employee_record_id is distinct from p_assigned_employee_record_id then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(p_organization_id,assigned_uuid,'TASK_ASSIGNED','INFO','Task assigned to you',btrim(p_title),'tasks','tasks',p_task_id::text,'task-reassigned:'||p_task_id::text||':'||(task_row.version+1)::text) on conflict do nothing;
  end if;
  return public.get_task_v2(p_organization_id,p_task_id);
end;
$$;

create or replace function public.create_task_command_v2(p_organization_id uuid,p_payload jsonb,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.task_create_commands_v2%rowtype;result jsonb;field text;owner_user uuid;hours numeric;starts date;due date;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'work.manage') or not public.has_org_capability(p_organization_id,'work.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='task_manage_required';end if;
 if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>65536 then raise exception 'task_payload_invalid';end if;
 if exists(select 1 from jsonb_object_keys(p_payload) k where k not in('p_title','p_client_account_id','p_project_record_id','p_assigned_employee_record_id','p_priority','p_task_type','p_start_date','p_due_date','p_estimated_hours','p_brief','p_requirements','p_reference_links','p_client_visible')) then raise exception 'task_payload_field_unknown';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into prior from public.task_create_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then
  if prior.actor_user_id<>auth.uid() or prior.request<>p_payload then raise exception 'idempotency_conflict';end if;
  result=public.get_task_v2(p_organization_id,prior.task_id);
  if not coalesce((result->>'ok')::boolean,false) then raise exception 'created_task_unavailable';end if;
  return result||jsonb_build_object('replayed',true);
 end if;
 foreach field in array array['p_title','p_client_account_id','p_project_record_id','p_assigned_employee_record_id','p_priority','p_task_type','p_start_date','p_due_date','p_brief','p_requirements','p_reference_links'] loop
  if p_payload ? field and jsonb_typeof(p_payload->field) not in('string','null') then raise exception 'task_field_type_invalid';end if;
 end loop;
 if p_payload ? 'p_client_visible' and jsonb_typeof(p_payload->'p_client_visible')<>'boolean' then raise exception 'task_visibility_invalid';end if;
 if p_payload ? 'p_estimated_hours' and jsonb_typeof(p_payload->'p_estimated_hours')<>'number' then raise exception 'task_hours_invalid';end if;
 hours=coalesce((p_payload->>'p_estimated_hours')::numeric,0);
 if hours<0 or hours>10000 or hours<>round(hours,2) then raise exception 'task_hours_invalid';end if;
 starts=nullif(p_payload->>'p_start_date','')::date;due=nullif(p_payload->>'p_due_date','')::date;
 if (starts is not null and not isfinite(starts)) or (due is not null and not isfinite(due)) or (starts is not null and due is not null and due<starts) then raise exception 'task_dates_invalid';end if;
 owner_user=public.task_user_for_employee_v2(p_payload->>'p_assigned_employee_record_id');
 if owner_user is null or not exists(select 1 from public.records e join public.organization_members m on m.organization_id=e.organization_id and m.user_id=owner_user and m.status='ACTIVE' join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where e.organization_id=p_organization_id and e.id=p_payload->>'p_assigned_employee_record_id' and e.coll='employees' and e.deleted_at is null) then raise exception 'task_assignee_review_required';end if;
 result=public.create_task_v2(p_organization_id,p_payload->>'p_title',(p_payload->>'p_client_account_id')::uuid,p_payload->>'p_project_record_id',p_payload->>'p_assigned_employee_record_id','Backlog',coalesce(p_payload->>'p_priority','Normal'),p_payload->>'p_task_type',starts,due,hours,p_payload->>'p_brief',p_payload->>'p_requirements',p_payload->>'p_reference_links',coalesce((p_payload->>'p_client_visible')::boolean,false));
 if not coalesce((result->>'ok')::boolean,false) or result->'task'->>'id' is null then raise exception 'task_create_not_confirmed';end if;
 insert into public.task_create_commands_v2 values(p_organization_id,p_command_id,auth.uid(),p_payload,(result->'task'->>'id')::uuid,now());
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'TASK_CREATE_COMMAND','task',result->'task'->>'id',jsonb_build_object('commandId',p_command_id));
 return result||jsonb_build_object('replayed',false);
end;$$;
revoke all on function public.create_task_command_v2(uuid,jsonb,uuid) from public,anon;
grant execute on function public.create_task_command_v2(uuid,jsonb,uuid) to authenticated;
create or replace function public.guard_task_assignee_v2()
returns trigger language plpgsql security definer set search_path='' as $$
declare assigned uuid;
begin
 if auth.role() is distinct from 'authenticated' or new.coll<>'tasks' then return new;end if;
 if tg_op='UPDATE' and old.coll='tasks' and new.data->>'assignedTo' is not distinct from old.data->>'assignedTo' then return new;end if;
 assigned=public.task_user_for_employee_v2(new.data->>'assignedTo');
 if assigned is null or not exists(select 1 from public.records e join public.organization_members m on m.organization_id=e.organization_id and m.user_id=assigned and m.status='ACTIVE' join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where e.id=new.data->>'assignedTo' and e.organization_id=new.organization_id and e.coll='employees' and e.deleted_at is null) then raise exception 'task_assignee_review_required';end if;
 return new;
end;$$;
create trigger task_assignee_authority before insert or update on public.records for each row execute function public.guard_task_assignee_v2();
revoke all on function public.guard_task_assignee_v2() from public,anon,authenticated;
commit;
-- Rollback UI entry point only; retain committed tasks, request ledger and audit.
