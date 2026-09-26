-- Keep the authorized request CTE and its count/page in one SQL statement.
-- No access predicates, data, policies or grants change.
begin;
create or replace function public.list_employee_requests_v3(
  p_organization_id uuid,p_scope text default 'MINE',p_status text default null,p_type_key text default null,
  p_search text default null,p_from_date date default null,p_to_date date default null,p_page integer default 1,p_page_size integer default 30
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare scope_value text:=upper(coalesce(p_scope,'MINE')); page_value integer:=greatest(1,coalesce(p_page,1)); size_value integer:=least(100,greatest(1,coalesce(p_page_size,30))); result_value jsonb;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.read') then raise exception using errcode='42501',message='request_read_required'; end if;
  if scope_value not in ('MINE','QUEUE','AUTHORIZED','TEAM_CALENDAR') then raise exception using errcode='22023',message='request_scope_invalid'; end if;
  with allowed as (
    select req.*,policy.name_en,policy.name_ar
    from public.employee_requests_v3 req join public.employee_request_type_policies_v3 policy on policy.id=req.request_type_policy_id
    where req.organization_id=p_organization_id and req.deleted_at is null
      and (
        (scope_value<>'TEAM_CALENDAR' and public.employee_request_can_read_v3(req.organization_id,req.requester_user_id,req.classification,req.id))
        or (scope_value='TEAM_CALENDAR' and public.is_active_org_member(p_organization_id)
          and req.category in ('LEAVE','REMOTE_WORK','ATTENDANCE')
          and req.status in ('APPROVED','PARTIALLY_APPROVED','COMPLETED'))
      )
      and (scope_value<>'MINE' or req.requester_user_id=auth.uid())
      and (scope_value<>'QUEUE' or exists(select 1 from public.employee_request_steps_v3 step where step.request_id=req.id and step.step_no=req.current_step and step.status='PENDING' and (step.assigned_user_id=auth.uid() or (step.assigned_user_id is null and public.has_org_capability(p_organization_id,step.required_capability)))))
      and (scope_value<>'TEAM_CALENDAR' or (req.category in ('LEAVE','REMOTE_WORK','ATTENDANCE') and req.status in ('APPROVED','PARTIALLY_APPROVED','COMPLETED')))
      and (p_status is null or req.status=p_status)
      and (p_type_key is null or req.request_type_key=p_type_key)
      and (p_from_date is null or coalesce(req.start_date,req.request_date)>=p_from_date)
      and (p_to_date is null or coalesce(req.end_date,req.start_date,req.request_date)<=p_to_date)
      and (p_search is null or req.request_number ilike '%'||p_search||'%' or req.title ilike '%'||p_search||'%')
  ), totals as (select count(*)::integer total_value from allowed)
  select jsonb_build_object('items',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',item.id,'requestNumber',item.request_number,'typeKey',item.request_type_key,
      'typeNameEn',item.name_en,'typeNameAr',item.name_ar,'category',item.category,
      'classification',item.classification,'title',case when scope_value='TEAM_CALENDAR' then item.name_en else item.title end,
      'employeeName',case when scope_value='TEAM_CALENDAR' then coalesce((select employee.data->>'fullName' from public.records employee where employee.organization_id=item.organization_id and employee.coll='employees' and employee.id=item.employee_record_id and employee.deleted_at is null), 'Team member') else null end,
      'status',item.status,'priority',item.priority,
      'requestDate',item.request_date,'startDate',item.start_date,'endDate',item.end_date,
      'startTime',item.start_time,'endTime',item.end_time,'requestedUnits',item.requested_units,'approvedUnits',item.approved_units,
      'unitKind',item.unit_kind,'currentStep',item.current_step,'version',item.version,
      'effectStatus',item.effect_status,'requesterUserId',item.requester_user_id,
      'isMine',item.requester_user_id=auth.uid(),'submittedAt',item.submitted_at,'updatedAt',item.updated_at,
      'currentReviewer',coalesce((select step.step_type from public.employee_request_steps_v3 step where step.request_id=item.id and step.step_no=item.current_step),'—')
    ) order by item.updated_at desc)
    from (select * from allowed order by updated_at desc limit size_value offset (page_value-1)*size_value) item
  ),'[]'::jsonb),'total',total_value,'page',page_value,'pageSize',size_value,'pages',greatest(1,ceil(total_value::numeric/size_value)::integer)) into result_value from totals;
  return result_value;
end;
$$;
commit;
