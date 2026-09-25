-- Status mutations use one authorized transition path, including legacy board actions.
-- Existing statuses/history are retained. New browser tasks begin in preparation.
begin;
create or replace function public.guard_task_status_command_v2()
returns trigger language plpgsql set search_path='' as $$
begin
 if auth.role()<>'authenticated' or new.coll<>'tasks' then return new;end if;
 if tg_op='INSERT' or old.coll<>'tasks' then
  if coalesce(new.data->>'status','Backlog') not in('Backlog','To Do') or nullif(new.data->>'completedAt','') is not null or nullif(new.data->>'completedBy','') is not null then raise exception 'task_initial_status_invalid';end if;
 elsif (new.data->'status',new.data->'completedAt',new.data->'completedBy') is distinct from (old.data->'status',old.data->'completedAt',old.data->'completedBy') and coalesce(current_setting('app.task_status_command',true),'')<>old.id then
  raise exception using errcode='42501',message='task_status_command_required';
 end if;
 return new;
end;$$;
create trigger task_status_authority before insert or update on public.records for each row execute function public.guard_task_status_command_v2();
create or replace function public.change_task_status_v2(
  p_organization_id uuid,p_task_id uuid,p_expected_version integer,p_status text,p_note text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare manager boolean; declare allowed boolean:=false; declare completion_value text; declare previous_command text:=current_setting('app.task_status_command',true);
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'work.read') then
    raise exception using errcode='42501',message='work_access_required';
  end if;
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null for update;
  if task_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  manager:=public.has_org_capability(p_organization_id,'work.manage');
  if not manager and not public.task_is_current_assignee_v2(task_row.assigned_user_id,task_row.assigned_employee_record_id) then raise exception using errcode='42501',message='task_status_not_allowed'; end if;
  if task_row.version<>p_expected_version then raise exception using errcode='40001',message='task_version_conflict'; end if;
  if p_status is null or p_status not in ('Backlog','To Do','In Progress','Waiting for Client','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled') then raise exception 'invalid_task_status'; end if;
  allowed:=case task_row.status
    when 'Backlog' then p_status in ('To Do','In Progress','Blocked','Cancelled')
    when 'To Do' then p_status in ('In Progress','Blocked','Cancelled')
    when 'In Progress' then p_status in ('Waiting for Client','Internal Review','Done','Blocked','Cancelled')
    when 'Waiting for Client' then p_status in ('In Progress','Internal Review','Client Review','Blocked','Cancelled')
    when 'Internal Review' then p_status in ('In Progress','Client Review','Done','Blocked')
    when 'Client Review' then p_status in ('Revisions','Approved','Done','Blocked')
    when 'Revisions' then p_status in ('In Progress','Internal Review','Blocked')
    when 'Approved' then p_status in ('Scheduled','Delivered','Done')
    when 'Scheduled' then p_status in ('Delivered','Done')
    when 'Delivered' then p_status='Done'
    when 'Blocked' then p_status in ('To Do','In Progress','Cancelled')
    when 'Done' then manager and p_status='In Progress'
    when 'Cancelled' then manager and p_status='Backlog' else false end;
  if not allowed then raise exception using errcode='P0001',message='invalid_task_transition'; end if;
  if not manager and p_status not in ('In Progress','Waiting for Client','Internal Review','Done','Blocked') then raise exception using errcode='42501',message='assignee_transition_not_allowed'; end if;
  completion_value:=case when p_status='Done' then now()::text when task_row.status='Done' then '' else coalesce(task_row.completed_at::text,'') end;
  perform set_config('app.task_status_command',task_row.legacy_record_id,true);
  update public.records set data=data||jsonb_build_object('status',p_status,'completedAt',completion_value,
    'completedBy',case when p_status='Done' then auth.uid()::text when task_row.status='Done' then '' else coalesce((data->>'completedBy'),'') end,
    'blockers',case when p_status='Blocked' then coalesce(nullif(btrim(p_note),''),coalesce(data->>'blockers','')) else coalesce(data->>'blockers','') end,'updatedAt',now()),updated_at=now()
  where organization_id=p_organization_id and id=task_row.legacy_record_id;
  perform set_config('app.task_status_command',coalesce(previous_command,''),true);
  insert into public.task_events_v2(organization_id,task_id,action,from_status,to_status,note,actor_user_id)
  values(p_organization_id,p_task_id,'STATUS_CHANGED',task_row.status,p_status,nullif(btrim(coalesce(p_note,'')),''),auth.uid());
  if task_row.created_by_user_id is not null and task_row.created_by_user_id<>auth.uid() then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(p_organization_id,task_row.created_by_user_id,'TASK_STATUS',case when p_status='Blocked' then 'WARNING' when p_status='Done' then 'SUCCESS' else 'INFO' end,
      'Task status updated',task_row.title||' → '||p_status,'tasks','tasks',p_task_id::text,'task-status:'||p_task_id::text||':'||(task_row.version+1)::text) on conflict do nothing;
  end if;
  return public.get_task_v2(p_organization_id,p_task_id);
end;
$$;

create or replace function public.get_task_v2(p_organization_id uuid,p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype;
begin
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null;
  if task_row.id is null or not public.can_read_task_v2(task_row.organization_id,task_row.legacy_client_id,task_row.assigned_user_id,task_row.assigned_employee_record_id,task_row.client_visible) then return jsonb_build_object('ok',false,'error','not_found'); end if;
  return jsonb_build_object('ok',true,'task',jsonb_build_object(
'id',task_row.id,'legacyRecordId',task_row.legacy_record_id,'taskCode',task_row.task_code,'title',task_row.title,'description',task_row.description,
    'clientAccountId',task_row.client_account_id,'clientId',task_row.legacy_client_id,'projectId',task_row.project_record_id,
    'deliverableId',task_row.deliverable_record_id,'assignedTo',task_row.assigned_employee_record_id,'assignedUserId',task_row.assigned_user_id,
    'status',task_row.status,'priority',task_row.priority,'taskType',task_row.task_type,'startDate',task_row.start_date,'dueDate',task_row.due_date,
    'completedAt',task_row.completed_at,'estimatedHours',task_row.estimated_hours,'actualHours',task_row.actual_hours,
    'brief',task_row.brief,'requirements',task_row.requirements,'referenceLinks',task_row.reference_links,'deliveryLink',task_row.delivery_link,
    'blockers',task_row.blockers,'clientVisible',task_row.client_visible,'version',task_row.version,'updatedAt',task_row.updated_at,
    'canManage',public.has_org_capability(task_row.organization_id,'work.manage'),
    'canChangeStatus',public.has_org_capability(task_row.organization_id,'work.manage') or public.task_is_current_assignee_v2(task_row.assigned_user_id,task_row.assigned_employee_record_id)
),
    'timeline',coalesce((select jsonb_agg(jsonb_build_object('id',event.id,'action',event.action,'fromStatus',event.from_status,'toStatus',event.to_status,'note',event.note,'occurredAt',event.occurred_at) order by event.occurred_at desc) from public.task_events_v2 event where event.task_id=task_row.id),'[]'::jsonb),
    'comments',coalesce((select jsonb_agg(jsonb_build_object('id',comment.id,'body',comment.body,'visibility',comment.visibility,'authorUserId',comment.author_user_id,'createdAt',comment.created_at) order by comment.created_at) from public.task_comments_v2 comment where comment.task_id=task_row.id and comment.deleted_at is null and (public.current_member_role_key(p_organization_id)<>'client' or comment.visibility='CLIENT')),'[]'::jsonb),
    'documents',coalesce((select jsonb_agg(jsonb_build_object('id',document.id,'title',document.title,'documentType',document.document_type,'mimeType',document.mime_type,'status',document.status) order by link.created_at desc) from public.task_document_links_v2 link join public.document_files document on document.id=link.document_id where link.task_id=task_row.id and document.deleted_at is null and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)),'[]'::jsonb));
end;
$$;


create or replace function public.change_task_record_status_v2(p_organization_id uuid,p_record_id text,p_expected_status text,p_status text,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.work_tasks%rowtype; result jsonb;record jsonb;
begin
 if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'work.read') then raise exception using errcode='42501',message='work_access_required';end if;
 select * into task from public.work_tasks where organization_id=p_organization_id and legacy_record_id=p_record_id and deleted_at is null for update;
 if task.id is null or not public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible) then raise exception 'task_unavailable';end if;
 if task.status is distinct from p_expected_status then raise exception using errcode='40001',message='task_status_conflict_reload';end if;
 result=public.change_task_status_v2(p_organization_id,task.id,task.version,p_status,p_note);
 if not coalesce((result->>'ok')::boolean,false) then raise exception 'task_status_not_confirmed';end if;
 select data||jsonb_build_object('id',id) into record from public.records where organization_id=p_organization_id and id=p_record_id and coll='tasks' and deleted_at is null;
 return jsonb_build_object('ok',true,'record',record,'task',result->'task');
end;$$;
create or replace function public.get_task_record_v2(p_organization_id uuid,p_record_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare task public.work_tasks%rowtype;result jsonb;record jsonb;
begin
 select * into task from public.work_tasks where organization_id=p_organization_id and legacy_record_id=p_record_id and deleted_at is null;
 if task.id is null then raise exception 'task_unavailable';end if;
 result=public.get_task_v2(p_organization_id,task.id);
 if not coalesce((result->>'ok')::boolean,false) then raise exception using errcode='42501',message='task_read_required';end if;
 select data||jsonb_build_object('id',id) into record from public.records where organization_id=p_organization_id and id=p_record_id and coll='tasks' and deleted_at is null;
 return result||jsonb_build_object('record',record);
end;$$;
revoke all on function public.get_task_record_v2(uuid,text) from public,anon;
grant execute on function public.get_task_record_v2(uuid,text) to authenticated;
revoke all on function public.guard_task_status_command_v2() from public,anon,authenticated;
revoke all on function public.change_task_record_status_v2(uuid,text,text,text,text) from public,anon;
grant execute on function public.change_task_record_status_v2(uuid,text,text,text,text) to authenticated;
commit;
-- Rollback application to read-only task state while repairing; retain history and records.
