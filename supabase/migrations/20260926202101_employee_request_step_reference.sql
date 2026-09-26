-- Function-only fix for direct and saved-draft request submission.
-- Qualify the routing-step column instead of colliding with the PL/pgSQL counter.
-- No data, policies, grants, approval routes or employee mappings change.
begin;
create or replace function public.submit_employee_request_v3(
  p_organization_id uuid,p_type_key text,p_title text,p_priority text,p_request_date date,
  p_start_date date,p_end_date date,p_start_time time,p_end_time time,
  p_public_details jsonb,p_sensitive_details jsonb,p_expense_lines jsonb,
  p_document_ids uuid[],p_idempotency_key text,p_save_draft boolean default false
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee_id text; manager_id uuid; employee_department text; policy_row public.employee_request_type_policies_v3%rowtype; req public.employee_requests_v3%rowtype; step_value jsonb; step_no integer:=0; step_name text; capability_name text; units numeric:=0; quote jsonb; document_id uuid; line jsonb; status_value text; route_value jsonb; reason_value text;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.create') then raise exception using errcode='42501',message='request_create_required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then raise exception using errcode='22023',message='request_idempotency_required'; end if;
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and requester_user_id=auth.uid() and idempotency_key=p_idempotency_key;
  if req.id is not null then return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',true); end if;
  employee_id:=public.employee_request_employee_for_user_v3(auth.uid());
  if employee_id is null then raise exception using errcode='P0001',message='employee_identity_link_required'; end if;
  if not exists(select 1 from public.records employee where employee.organization_id=p_organization_id and employee.id=employee_id and employee.coll='employees' and employee.deleted_at is null) then raise exception using errcode='23503',message='employee_record_not_found'; end if;
  select * into policy_row from public.employee_request_type_policies_v3 where organization_id=p_organization_id and type_key=p_type_key and is_current and enabled;
  if policy_row.id is null then raise exception using errcode='22023',message='request_type_unavailable'; end if;
  if p_public_details is null or jsonb_typeof(p_public_details)<>'object' then raise exception using errcode='22023',message='request_details_invalid'; end if;
  if p_sensitive_details is null or jsonb_typeof(p_sensitive_details)<>'object' then raise exception using errcode='22023',message='request_sensitive_details_invalid'; end if;
  if p_public_details ?| array['organizationId','employeeId','requesterUserId','status','approvers','balance','approvedBy'] then raise exception using errcode='22023',message='request_server_field_claim_rejected'; end if;
  if p_start_date is not null and p_end_date is not null and p_end_date<p_start_date then raise exception using errcode='22023',message='request_date_range_invalid'; end if;
  manager_id:=public.employee_request_manager_for_employee_v3(p_organization_id,employee_id);
  select coalesce(employee.data->>'department',employee.data->>'departmentName','') into employee_department
  from public.records employee where employee.organization_id=p_organization_id and employee.id=employee_id and employee.coll='employees' and employee.deleted_at is null;
  if policy_row.category='LEAVE' and not p_save_draft then
    quote:=public.quote_employee_request_v3(p_organization_id,p_type_key,p_start_date,p_end_date,case when p_public_details->>'dayPart'='HALF_DAY' then .5 else 1 end);
    units:=coalesce((quote->>'requested')::numeric,0);
    if quote->>'remaining' is not null and (quote->>'remaining')::numeric<0 then raise exception using errcode='P0001',message='leave_balance_insufficient'; end if;
  elsif policy_row.category='REMOTE_WORK' then
    select count(*) into units from generate_series(coalesce(p_start_date,p_request_date,current_date),coalesce(p_end_date,p_start_date,p_request_date,current_date),interval '1 day') day
    where extract(isodow from day)::integer not in (select value::integer from jsonb_array_elements_text(coalesce(policy_row.policy->'weekendDays','[5,6]'::jsonb)) value)
      and not exists(select 1 from public.employee_request_holidays_v3 holiday where holiday.organization_id=p_organization_id and holiday.holiday_date=day::date);
  elsif policy_row.type_key in ('late_arrival','delay_notification') then
    p_start_time:=case when coalesce(p_public_details->>'normalShiftStart','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'normalShiftStart')::time else p_start_time end;
    p_end_time:=case when coalesce(p_public_details->>'expectedArrivalTime','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'expectedArrivalTime')::time else p_end_time end;
    if p_start_time is not null and p_end_time is not null then units:=greatest(0,extract(epoch from (p_end_time-p_start_time))/3600); end if;
  elsif policy_row.type_key='early_leave' then
    p_start_time:=case when coalesce(p_public_details->>'requestedLeavingTime','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'requestedLeavingTime')::time else p_start_time end;
    p_end_time:=case when coalesce(p_public_details->>'normalShiftEnd','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'normalShiftEnd')::time else p_end_time end;
    if p_start_time is not null and p_end_time is not null then units:=greatest(0,extract(epoch from (p_end_time-p_start_time))/3600); end if;
  elsif policy_row.category in ('ATTENDANCE','SCHEDULE','OVERTIME') and p_start_time is not null and p_end_time is not null then
    units:=greatest(0,extract(epoch from (p_end_time-p_start_time))/3600);
  elsif policy_row.category='EXPENSE' then
    if p_expense_lines is null or jsonb_typeof(p_expense_lines)<>'array' or jsonb_array_length(p_expense_lines)=0 then raise exception using errcode='22023',message='expense_lines_required'; end if;
    select coalesce(sum((item->>'amount')::numeric),0) into units from jsonb_array_elements(p_expense_lines) item where coalesce(item->>'amount','')~'^[0-9]+([.][0-9]+)?$';
    if units<=0 then raise exception using errcode='22023',message='expense_total_invalid'; end if;
  elsif policy_row.category='SALARY_ADVANCE' then
    if coalesce(p_sensitive_details->>'amount','')!~'^[0-9]+([.][0-9]+)?$' then raise exception using errcode='22023',message='salary_advance_amount_invalid'; end if;
    units:=(p_sensitive_details->>'amount')::numeric;
  end if;
  reason_value:=coalesce(nullif(btrim(p_public_details->>'reason'),''),nullif(btrim(p_sensitive_details->>'reason'),''),nullif(btrim(p_sensitive_details->>'description'),''),nullif(btrim(p_sensitive_details->>'purpose'),''),case when policy_row.category='EXPENSE' then (select nullif(btrim(item->>'businessReason'),'') from jsonb_array_elements(coalesce(p_expense_lines,'[]'::jsonb)) item limit 1) end);
  if not p_save_draft and reason_value is null then raise exception using errcode='22023',message='request_reason_required'; end if;
  if not p_save_draft and policy_row.policy ? 'minNoticeDays' and coalesce(p_start_date,p_request_date,current_date)-current_date < (policy_row.policy->>'minNoticeDays')::integer then raise exception using errcode='P0001',message='request_minimum_notice_required'; end if;
  if not p_save_draft and policy_row.policy ? 'maxConsecutiveDays' and units > (policy_row.policy->>'maxConsecutiveDays')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if not p_save_draft and policy_row.policy ? 'maxHours' and units > (policy_row.policy->>'maxHours')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if not p_save_draft and policy_row.policy ? 'maxHoursPerDay' and units > (policy_row.policy->>'maxHoursPerDay')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if not p_save_draft and policy_row.type_key='sick_leave'
     and policy_row.policy ? 'medicalCertificateAfterDays'
     and units >= (policy_row.policy->>'medicalCertificateAfterDays')::numeric
     and coalesce(array_length(p_document_ids,1),0)=0 then
    raise exception using errcode='P0001',message='medical_certificate_required';
  end if;
  if not p_save_draft and exists(
    select 1 from public.employee_requests_v3 duplicate
    where duplicate.organization_id=p_organization_id and duplicate.employee_record_id=employee_id
      and duplicate.request_type_key=policy_row.type_key and duplicate.deleted_at is null
      and duplicate.status not in ('DRAFT','REJECTED','CANCELLED','EXPIRED')
      and daterange(coalesce(duplicate.start_date,duplicate.request_date),coalesce(duplicate.end_date,duplicate.start_date,duplicate.request_date),'[]')
        && daterange(coalesce(p_start_date,p_request_date,current_date),coalesce(p_end_date,p_start_date,p_request_date,current_date),'[]')
  ) then raise exception using errcode='P0001',message='duplicate_request_exists'; end if;
  if not p_save_draft and coalesce(policy_row.policy->>'attachment','optional')='required' and coalesce(array_length(p_document_ids,1),0)=0 then raise exception using errcode='P0001',message='request_attachment_required'; end if;
  status_value:=case when p_save_draft then 'DRAFT' else 'SUBMITTED' end;
  insert into public.employee_requests_v3(
    organization_id,request_number,request_type_policy_id,request_type_key,category,classification,
    requester_user_id,employee_record_id,direct_manager_user_id,title,status,priority,request_date,
    start_date,end_date,start_time,end_time,requested_units,unit_kind,public_details,idempotency_key,
    effect_status,submitted_at
  ) values (
    p_organization_id,'REQ-'||to_char(now(),'YYYYMM')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),policy_row.id,policy_row.type_key,policy_row.category,policy_row.classification,
    auth.uid(),employee_id,manager_id,left(btrim(p_title),240),status_value,case when upper(coalesce(p_priority,'NORMAL')) in ('LOW','NORMAL','HIGH','URGENT') then upper(p_priority) else 'NORMAL' end,coalesce(p_request_date,current_date),
    p_start_date,p_end_date,p_start_time,p_end_time,units,case when policy_row.category in ('LEAVE','REMOTE_WORK') then 'DAYS' when policy_row.category in ('ATTENDANCE','OVERTIME') then 'HOURS' when policy_row.category in ('EXPENSE','SALARY_ADVANCE') then 'AMOUNT' else null end,p_public_details,p_idempotency_key,
    case when policy_row.category in ('LEAVE','ATTENDANCE','REMOTE_WORK','SCHEDULE','OVERTIME','EXPENSE','SALARY_ADVANCE') then 'PENDING' else 'NOT_REQUIRED' end,case when p_save_draft then null else now() end
  ) returning * into req;
  if policy_row.classification<>'INTERNAL' then
    insert into public.employee_request_sensitive_v3(organization_id,request_id,classification,details)
    values(p_organization_id,req.id,policy_row.classification,coalesce(p_sensitive_details,'{}'::jsonb));
  end if;
  if policy_row.category='EXPENSE' then
    for line in select value from jsonb_array_elements(p_expense_lines) loop
      step_no:=step_no+1;
      insert into public.employee_request_expense_lines_v3(organization_id,request_id,line_no,expense_date,category,amount,currency,client_or_project,business_reason,receipt_document_id)
      values(p_organization_id,req.id,step_no,coalesce(nullif(line->>'expenseDate','')::date,current_date),left(coalesce(nullif(btrim(line->>'category'),''),'Other'),120),(line->>'amount')::numeric,upper(coalesce(nullif(line->>'currency',''),'EGP')),nullif(line->>'clientOrProject',''),left(coalesce(nullif(btrim(line->>'businessReason'),''),'Business expense'),1000),case when coalesce(line->>'receiptDocumentId','')~'^[a-f0-9-]{36}$' then (line->>'receiptDocumentId')::uuid else null end);
    end loop;
  end if;
  if p_document_ids is not null then foreach document_id in array p_document_ids loop
    if not exists(select 1 from public.document_files document where document.organization_id=p_organization_id and document.id=document_id and document.deleted_at is null and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)) then raise exception using errcode='42501',message='request_document_not_allowed'; end if;
    insert into public.employee_request_documents_v3(organization_id,request_id,document_id,attached_by) values(p_organization_id,req.id,document_id,auth.uid()) on conflict do nothing;
  end loop; end if;
  step_no:=0; route_value:=policy_row.approval_route;
  if policy_row.type_key='equipment' and lower(coalesce(p_public_details->>'purchaseRequired','false')) in ('true','1','yes') then route_value:=route_value||jsonb_build_array(jsonb_build_object('step','FINANCE','capability','finance.manage')); end if;
  if not p_save_draft then
    for step_value in select value from jsonb_array_elements(route_value) loop
      if step_value ? 'minAmount' and units < (step_value->>'minAmount')::numeric then continue; end if;
      if step_value ? 'maxAmount' and units > (step_value->>'maxAmount')::numeric then continue; end if;
      if step_value ? 'minDays' and units < (step_value->>'minDays')::numeric then continue; end if;
      if step_value ? 'maxDays' and units > (step_value->>'maxDays')::numeric then continue; end if;
      if step_value ? 'department' and lower(btrim(step_value->>'department'))<>lower(btrim(employee_department)) then continue; end if;
      step_no:=step_no+1; step_name:=upper(step_value->>'step'); capability_name:=nullif(step_value->>'capability','');
      if step_name='MANAGER' and manager_id is null then raise exception using errcode='P0001',message='direct_manager_required'; end if;
      insert into public.employee_request_steps_v3(organization_id,request_id,step_no,step_type,required_capability,assigned_user_id,status,employee_visible)
      values(p_organization_id,req.id,step_no,step_name,case when step_name='MANAGER' then null else capability_name end,case when step_name='MANAGER' then manager_id else null end,case when step_no=1 then 'PENDING' else 'WAITING' end,policy_row.classification<>'CONFIDENTIAL');
    end loop;
    if step_no=0 then raise exception using errcode='P0001',message='request_approval_route_missing'; end if;
    update public.employee_requests_v3 set current_step=1,status=case (select routing_step.step_type from public.employee_request_steps_v3 routing_step where routing_step.request_id=req.id and routing_step.step_no=1) when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end,updated_at=now() where id=req.id returning * into req;
  end if;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,to_status,actor_user_id,employee_visible,safe_context)
  values(p_organization_id,req.id,case when p_save_draft then 'DRAFT_SAVED' else 'SUBMITTED' end,req.status,auth.uid(),true,jsonb_build_object('typeKey',req.request_type_key,'policyVersion',policy_row.version));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values(p_organization_id,auth.uid(),case when p_save_draft then 'employee_request.draft_saved' else 'employee_request.submitted' end,'employee_request',req.id::text,jsonb_build_object('typeKey',req.request_type_key,'classification',req.classification));
  if not p_save_draft then perform public.employee_request_notify_step_v3(req.id); end if;
  return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',false);
end;
$$;

create or replace function public.submit_saved_employee_request_v3(
  p_organization_id uuid,p_request_id uuid,p_expected_version integer,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; policy_row public.employee_request_type_policies_v3%rowtype; manager_id uuid; employee_department text; units numeric:=0; quote jsonb; route_value jsonb; step_value jsonb; step_no integer:=0; step_name text; capability_name text; reason_value text;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.create') then raise exception using errcode='42501',message='request_create_required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then raise exception using errcode='22023',message='request_idempotency_required'; end if;
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and requester_user_id=auth.uid() and deleted_at is null for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if req.version<>p_expected_version then raise exception using errcode='40001',message='request_version_conflict'; end if;
  if req.status<>'DRAFT' then return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',true); end if;
  select * into policy_row from public.employee_request_type_policies_v3 where organization_id=p_organization_id and type_key=req.request_type_key and is_current and enabled;
  if policy_row.id is null then raise exception using errcode='P0001',message='request_type_unavailable'; end if;
  manager_id:=public.employee_request_manager_for_employee_v3(p_organization_id,req.employee_record_id);
  select coalesce(employee.data->>'department',employee.data->>'departmentName','') into employee_department from public.records employee where employee.organization_id=p_organization_id and employee.id=req.employee_record_id and employee.coll='employees' and employee.deleted_at is null;
  reason_value:=coalesce(nullif(btrim(req.public_details->>'reason'),''),(select nullif(btrim(sensitive.details->>'reason'),'') from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),(select nullif(btrim(sensitive.details->>'description'),'') from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),(select nullif(btrim(sensitive.details->>'purpose'),'') from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),(select nullif(btrim(line.business_reason),'') from public.employee_request_expense_lines_v3 line where line.request_id=req.id order by line.line_no limit 1));
  if reason_value is null then raise exception using errcode='22023',message='request_reason_required'; end if;
  if req.start_date is not null and req.end_date is not null and req.end_date<req.start_date then raise exception using errcode='22023',message='request_date_range_invalid'; end if;
  if coalesce(policy_row.policy->>'attachment','optional')='required' and not exists(select 1 from public.employee_request_documents_v3 document where document.request_id=req.id) then raise exception using errcode='P0001',message='request_attachment_required'; end if;
  if policy_row.category='LEAVE' then
    quote:=public.quote_employee_request_v3(p_organization_id,policy_row.type_key,req.start_date,req.end_date,case when req.public_details->>'dayPart'='HALF_DAY' then .5 else 1 end);
    units:=coalesce((quote->>'requested')::numeric,0);
    if quote->>'remaining' is not null and (quote->>'remaining')::numeric<0 then raise exception using errcode='P0001',message='leave_balance_insufficient'; end if;
  elsif policy_row.category='EXPENSE' then
    select coalesce(sum(line.amount),0) into units from public.employee_request_expense_lines_v3 line where line.request_id=req.id;
    if units<=0 then raise exception using errcode='22023',message='expense_total_invalid'; end if;
  elsif policy_row.category='SALARY_ADVANCE' then
    select case when coalesce(sensitive.details->>'amount','')~'^[0-9]+([.][0-9]+)?$' then (sensitive.details->>'amount')::numeric else 0 end into units from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id;
    if units<=0 then raise exception using errcode='22023',message='salary_advance_amount_invalid'; end if;
  else units:=coalesce(req.requested_units,0);
  end if;
  if policy_row.policy ? 'minNoticeDays' and coalesce(req.start_date,req.request_date,current_date)-current_date < (policy_row.policy->>'minNoticeDays')::integer then raise exception using errcode='P0001',message='request_minimum_notice_required'; end if;
  if policy_row.policy ? 'maxConsecutiveDays' and units > (policy_row.policy->>'maxConsecutiveDays')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if policy_row.type_key='sick_leave' and policy_row.policy ? 'medicalCertificateAfterDays' and units >= (policy_row.policy->>'medicalCertificateAfterDays')::numeric and not exists(select 1 from public.employee_request_documents_v3 document where document.request_id=req.id) then raise exception using errcode='P0001',message='medical_certificate_required'; end if;
  if exists(select 1 from public.employee_requests_v3 duplicate where duplicate.organization_id=p_organization_id and duplicate.employee_record_id=req.employee_record_id and duplicate.id<>req.id and duplicate.request_type_key=req.request_type_key and duplicate.deleted_at is null and duplicate.status not in ('DRAFT','REJECTED','CANCELLED','EXPIRED') and daterange(coalesce(duplicate.start_date,duplicate.request_date),coalesce(duplicate.end_date,duplicate.start_date,duplicate.request_date),'[]') && daterange(coalesce(req.start_date,req.request_date),coalesce(req.end_date,req.start_date,req.request_date),'[]')) then raise exception using errcode='P0001',message='duplicate_request_exists'; end if;
  route_value:=policy_row.approval_route;
  if policy_row.type_key='equipment' and lower(coalesce(req.public_details->>'purchaseRequired','false')) in ('true','1','yes') then route_value:=route_value||jsonb_build_array(jsonb_build_object('step','FINANCE','capability','finance.manage')); end if;
  for step_value in select value from jsonb_array_elements(route_value) loop
    if step_value ? 'minAmount' and units < (step_value->>'minAmount')::numeric then continue; end if;
    if step_value ? 'maxAmount' and units > (step_value->>'maxAmount')::numeric then continue; end if;
    if step_value ? 'minDays' and units < (step_value->>'minDays')::numeric then continue; end if;
    if step_value ? 'maxDays' and units > (step_value->>'maxDays')::numeric then continue; end if;
    if step_value ? 'department' and lower(btrim(step_value->>'department'))<>lower(btrim(employee_department)) then continue; end if;
    step_no:=step_no+1;step_name:=upper(step_value->>'step');capability_name:=nullif(step_value->>'capability','');
    if step_name='MANAGER' and manager_id is null then raise exception using errcode='P0001',message='direct_manager_required'; end if;
    insert into public.employee_request_steps_v3(organization_id,request_id,step_no,step_type,required_capability,assigned_user_id,status,employee_visible) values(p_organization_id,req.id,step_no,step_name,case when step_name='MANAGER' then null else capability_name end,case when step_name='MANAGER' then manager_id else null end,case when step_no=1 then 'PENDING' else 'WAITING' end,policy_row.classification<>'CONFIDENTIAL');
  end loop;
  if step_no=0 then raise exception using errcode='P0001',message='request_approval_route_missing'; end if;
  update public.employee_requests_v3 set request_type_policy_id=policy_row.id,direct_manager_user_id=manager_id,requested_units=units,current_step=1,status=case (select routing_step.step_type from public.employee_request_steps_v3 routing_step where routing_step.request_id=req.id and routing_step.step_no=1) when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end,submitted_at=now(),updated_at=now(),version=version+1,idempotency_key=p_idempotency_key where id=req.id returning * into req;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,from_status,to_status,actor_user_id,employee_visible,safe_context) values(p_organization_id,req.id,'SUBMITTED','DRAFT',req.status,auth.uid(),true,jsonb_build_object('typeKey',req.request_type_key,'policyVersion',policy_row.version));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'employee_request.draft_submitted','employee_request',req.id::text,jsonb_build_object('typeKey',req.request_type_key,'classification',req.classification));
  perform public.employee_request_notify_step_v3(req.id);
  return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',false);
end;
$$;
commit;
