-- Preserve all records. Ambiguous legacy identity is a review item, not authority.
-- Explicit task assignment remains authoritative; organization/capability checks
-- remain mandatory in can_read_task_v2 and every mutation command.
begin;
create or replace function public.task_user_for_employee_v2(p_employee_record_id text)
returns uuid language sql stable security definer set search_path='' as $$
  with candidates as (
    select link.auth_user_id as user_id from public.legacy_identity_links link
    where link.employee_record_id=p_employee_record_id
      and link.link_status='CONFIRMED' and link.auth_user_id is not null
      and nullif(btrim(p_employee_record_id),'') is not null
    union
    select profile.id from public.profiles profile
    where profile.employee_id=p_employee_record_id
      and nullif(btrim(p_employee_record_id),'') is not null
  )
  select case when count(*)=1 then (array_agg(user_id))[1] else null::uuid end
  from candidates;
$$;
create or replace function public.task_is_current_assignee_v2(p_assigned_user_id uuid,p_employee_record_id text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and coalesce(
    case when p_assigned_user_id is not null then p_assigned_user_id=auth.uid()
    else public.task_user_for_employee_v2(p_employee_record_id)=auth.uid() end,
    false
  );
$$;
revoke all on function public.task_user_for_employee_v2(text) from public,anon;
revoke all on function public.task_is_current_assignee_v2(uuid,text) from public,anon;
grant execute on function public.task_user_for_employee_v2(text) to authenticated,service_role;
grant execute on function public.task_is_current_assignee_v2(uuid,text) to authenticated,service_role;
commit;
