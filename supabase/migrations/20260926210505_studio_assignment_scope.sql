-- Studio must not inherit legacy work.manage as unrestricted creative access.
-- Managers need both work.manage and approvals.manage; other staff require assignment.
-- Existing task/document policies and all business rows are unchanged.
begin;
create or replace function public.studio_task_access_v2(p_organization_id uuid,p_task_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and public.current_member_role_key(p_organization_id)<>'client' and exists(
 select 1 from public.work_tasks t join public.records p on p.id=t.project_record_id and p.organization_id=t.organization_id and p.coll='projects' and p.deleted_at is null
 join public.client_accounts c on c.id=t.client_account_id and c.organization_id=t.organization_id and c.legacy_record_id=p.data->>'clientId' and c.deleted_at is null and c.archived_at is null
 where t.id=p_task_id and t.organization_id=p_organization_id and t.deleted_at is null
 and public.can_read_task_v2(t.organization_id,t.legacy_client_id,t.assigned_user_id,t.assigned_employee_record_id,t.client_visible)
 and ((public.has_org_capability(p_organization_id,'work.manage') and public.has_org_capability(p_organization_id,'approvals.manage')) or public.task_is_current_assignee_v2(t.assigned_user_id,t.assigned_employee_record_id)))
$$;
commit;
