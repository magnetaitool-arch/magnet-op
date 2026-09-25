-- No data rewrite. Revalidate identity membership/capability before assigned-user mutation.
-- See docs/TASK_AUTHORIZATION_REPAIR.md; independent hosted staging is required.
begin;

create or replace function public.change_task_status_v2(
  p_organization_id uuid,p_task_id uuid,p_expected_version integer,p_status text,p_note text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare manager boolean; declare allowed boolean:=false; declare completion_value text;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'work.read') then
    raise exception using errcode='42501',message='work_access_required';
  end if;
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null for update;
  if task_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  manager:=public.has_org_capability(p_organization_id,'work.manage');
  if not manager and not public.task_is_current_assignee_v2(task_row.assigned_user_id,task_row.assigned_employee_record_id) then raise exception using errcode='42501',message='task_status_not_allowed'; end if;
  if task_row.version<>p_expected_version then raise exception using errcode='40001',message='task_version_conflict'; end if;
  if p_status not in ('Backlog','To Do','In Progress','Waiting for Client','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled') then raise exception 'invalid_task_status'; end if;
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
  update public.records set data=data||jsonb_build_object('status',p_status,'completedAt',completion_value,
    'completedBy',case when p_status='Done' then auth.uid()::text when task_row.status='Done' then '' else coalesce((data->>'completedBy'),'') end,
    'blockers',case when p_status='Blocked' then coalesce(nullif(btrim(p_note),''),coalesce(data->>'blockers','')) else coalesce(data->>'blockers','') end,'updatedAt',now()),updated_at=now()
  where organization_id=p_organization_id and id=task_row.legacy_record_id;
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

commit;
