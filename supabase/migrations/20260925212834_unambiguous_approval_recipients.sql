-- Additive function repair only. Do not rewrite ambiguous identities or historic notifications.
-- All identity namespaces must agree; a matching UUID does not override conflicting
-- legacy mappings. Notifications additionally require live recipient tenant membership.
begin;
create or replace function public.approval_user_for_legacy_subject_v2(p_subject text)
returns uuid language sql stable security definer set search_path='' as $$
  with candidates as (
    select p.id as user_id from public.profiles p
      where nullif(btrim(p_subject),'') is not null
        and (p.id::text=p_subject or p.employee_id=p_subject)
    union
    select l.auth_user_id from public.legacy_identity_links l
      where nullif(btrim(p_subject),'') is not null and l.link_status='CONFIRMED'
        and l.auth_user_id is not null
        and (l.legacy_account_row_id=p_subject or l.employee_record_id=p_subject)
  )
  select case when count(*)=1 then (array_agg(user_id))[1] else null::uuid end
  from candidates;
$$;
create or replace function public.transition_approval_v2(
  p_organization_id uuid,
  p_collection text,
  p_record_id text,
  p_expected_status text,
  p_action text,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  source_row public.records%rowtype;
  related_row public.records%rowtype;
  source_data jsonb;
  next_data jsonb;
  related_data jsonb;
  changes jsonb := '[]'::jsonb;
  action_value text := upper(btrim(coalesce(p_action,'')));
  current_status text;
  next_status text;
  request_type text;
  related_id text;
  actor_role text;
  target_user uuid;
  allowed boolean := false;
  side_effect_id text;
  timestamp_value timestamptz := now();
begin
  if auth.uid() is null or not public.is_active_org_member(p_organization_id) then
    raise exception using errcode='42501',message='approval_membership_required';
  end if;
  if p_collection not in ('approvalRequests','deliverables','proposals','invoices') then
    raise exception using errcode='22023',message='approval_collection_invalid';
  end if;
  if action_value not in ('APPROVE','REJECT','REQUEST_CHANGES') then
    raise exception using errcode='22023',message='approval_action_invalid';
  end if;
  if char_length(coalesce(p_comment,''))>2000 then
    raise exception using errcode='22023',message='approval_comment_too_long';
  end if;

  select * into source_row
  from public.records record
  where record.organization_id=p_organization_id
    and record.id=p_record_id
    and record.coll=p_collection
    and record.deleted_at is null
    and lower(coalesce(record.data->>'_del','false'))<>'true'
  for update;
  if source_row.id is null then
    return jsonb_build_object('ok',false,'error','approval_item_not_found');
  end if;

  source_data:=coalesce(source_row.data,'{}'::jsonb);
  current_status:=coalesce(source_data->>'status','');
  request_type:=coalesce(source_data->>'requestType','');
  actor_role:=public.current_member_role_key(p_organization_id);

  if nullif(btrim(coalesce(p_expected_status,'')),'') is not null
     and current_status<>p_expected_status then
    raise exception using errcode='40001',message='approval_status_conflict';
  end if;

  if p_collection='approvalRequests' then
    allowed:=public.has_org_capability(p_organization_id,'approvals.manage')
      or (request_type=any(array['Leave Request','Permission Request','Lateness Report','Early Leave','Half Day'])
          and public.has_org_capability(p_organization_id,'hr.manage'))
      or (request_type=any(array['Expense Request','Purchase Request','Bonus Request','Salary Adjustment','Client Discount Request','Invoice Approval'])
          and public.has_org_capability(p_organization_id,'finance.manage'));
  elsif p_collection='invoices' then
    allowed:=public.has_org_capability(p_organization_id,'approvals.manage')
      or public.has_org_capability(p_organization_id,'finance.manage');
  else
    allowed:=public.has_org_capability(p_organization_id,'approvals.manage');
    if p_collection='deliverables' and actor_role='client' then
      allowed:=allowed and public.record_matches_current_client(source_data);
    end if;
  end if;
  if not allowed then
    raise exception using errcode='42501',message='approval_capability_required';
  end if;

  if p_collection='approvalRequests' then
    if current_status<>'Pending Approval' then
      raise exception using errcode='P0001',message='approval_request_not_pending';
    end if;
    next_status:=case action_value when 'APPROVE' then 'Approved' when 'REJECT' then 'Rejected' else 'Changes Requested' end;
  elsif p_collection='deliverables' then
    if action_value='APPROVE' and current_status not in ('Client Review','Internal Review') then
      raise exception using errcode='P0001',message='deliverable_not_reviewable';
    elsif action_value='REQUEST_CHANGES' and current_status not in ('Client Review','Internal Review') then
      raise exception using errcode='P0001',message='deliverable_not_reviewable';
    elsif action_value='REJECT' then
      raise exception using errcode='22023',message='deliverable_reject_unsupported';
    end if;
    next_status:=case action_value when 'APPROVE' then 'Approved' else 'Revision Requested' end;
  else
    if action_value<>'APPROVE' then
      raise exception using errcode='22023',message='document_approval_action_unsupported';
    end if;
    if current_status<>'Pending Internal Approval' then
      raise exception using errcode='P0001',message='document_not_pending_approval';
    end if;
    next_status:='Approved Internally';
  end if;

  next_data:=source_data||jsonb_build_object(
    'status',next_status,
    'managerComment',coalesce(p_comment,source_data->>'managerComment',''),
    'updatedAt',timestamp_value,
    'updatedBy',auth.uid()::text
  );
  if action_value='APPROVE' then
    next_data:=next_data||jsonb_build_object('approvedBy',auth.uid()::text,'approvedAt',timestamp_value);
    if p_collection='deliverables' then next_data:=next_data||jsonb_build_object('approvalStatus','Approved'); end if;
  elsif action_value='REJECT' then
    next_data:=next_data||jsonb_build_object('rejectedBy',auth.uid()::text,'rejectedAt',timestamp_value);
  elsif p_collection='deliverables' then
    next_data:=next_data||jsonb_build_object(
      'approvalStatus','Revision Requested',
      'clientFeedback',coalesce(nullif(btrim(coalesce(p_comment,'')),''),source_data->>'clientFeedback',''),
      'revisionCount',coalesce((source_data->>'revisionCount')::integer,0)+1
    );
  end if;

  update public.records record
  set data=next_data,updated_at=timestamp_value,updated_by=auth.uid()::text
  where record.id=source_row.id;
  changes:=changes||jsonb_build_array(jsonb_build_object('coll',p_collection,'id',source_row.id,'data',next_data));

  -- Approval-request effects are part of the same transaction. A broken link
  -- fails the whole decision instead of leaving a false green success state.
  if p_collection='approvalRequests' and action_value='APPROVE' then
    if request_type='Send to Client Approval' and nullif(source_data->>'deliverableId','') is not null then
      related_id:=source_data->>'deliverableId';
      select * into related_row from public.records record where record.organization_id=p_organization_id and record.id=related_id and record.coll='deliverables' and record.deleted_at is null for update;
      if related_row.id is null then raise exception using errcode='23503',message='approval_linked_deliverable_missing'; end if;
      related_data:=related_row.data||jsonb_build_object('status','Client Review','approvalStatus','Pending','updatedAt',timestamp_value,'updatedBy',auth.uid()::text);
      update public.records set data=related_data,updated_at=timestamp_value,updated_by=auth.uid()::text where id=related_row.id;
      changes:=changes||jsonb_build_array(jsonb_build_object('coll','deliverables','id',related_row.id,'data',related_data));
    elsif request_type='Invoice Approval' and nullif(source_data->>'invoiceId','') is not null then
      related_id:=source_data->>'invoiceId';
      select * into related_row from public.records record where record.organization_id=p_organization_id and record.id=related_id and record.coll='invoices' and record.deleted_at is null for update;
      if related_row.id is null then raise exception using errcode='23503',message='approval_linked_invoice_missing'; end if;
      related_data:=related_row.data||jsonb_build_object('status','Approved Internally','updatedAt',timestamp_value,'updatedBy',auth.uid()::text);
      update public.records set data=related_data,updated_at=timestamp_value,updated_by=auth.uid()::text where id=related_row.id;
      changes:=changes||jsonb_build_array(jsonb_build_object('coll','invoices','id',related_row.id,'data',related_data));
    elsif request_type='Proposal Approval' and nullif(source_data->>'proposalId','') is not null then
      related_id:=source_data->>'proposalId';
      select * into related_row from public.records record where record.organization_id=p_organization_id and record.id=related_id and record.coll='proposals' and record.deleted_at is null for update;
      if related_row.id is null then raise exception using errcode='23503',message='approval_linked_proposal_missing'; end if;
      related_data:=related_row.data||jsonb_build_object('status','Approved Internally','updatedAt',timestamp_value,'updatedBy',auth.uid()::text);
      update public.records set data=related_data,updated_at=timestamp_value,updated_by=auth.uid()::text where id=related_row.id;
      changes:=changes||jsonb_build_array(jsonb_build_object('coll','proposals','id',related_row.id,'data',related_data));
    elsif request_type in ('Leave Request','Half Day') then
      side_effect_id:='approval-leave-'||md5(source_row.id);
      related_data:=jsonb_build_object(
        'id',side_effect_id,'employeeId',coalesce(nullif(source_data->>'employeeId',''),source_data->>'requestedBy'),
        'employeeName',coalesce(source_data->>'requestedByName',''),'leaveType',coalesce(source_data->>'leaveType','Annual'),
        'startDate',coalesce(nullif(source_data->>'date',''),source_data->>'startDate'),
        'endDate',coalesce(nullif(source_data->>'endDate',''),nullif(source_data->>'date',''),source_data->>'startDate'),
        'days',case when request_type='Half Day' then 0.5 else coalesce((source_data->>'days')::numeric,1) end,
        'reason',coalesce(source_data->>'reason',source_data->>'description',''),'status','Approved',
        'approvedBy',auth.uid()::text,'approvedAt',timestamp_value,'source','request','requestId',source_row.id,
        'createdAt',timestamp_value,'updatedAt',timestamp_value,'createdBy',auth.uid()::text,'updatedBy',auth.uid()::text
      );
      insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by)
      values(side_effect_id,'leaves',related_data,p_organization_id,timestamp_value,timestamp_value,auth.uid()::text,auth.uid()::text)
      on conflict(id) do nothing;
      changes:=changes||jsonb_build_array(jsonb_build_object('coll','leaves','id',side_effect_id,'data',related_data));
    end if;
  end if;

  insert into public.approval_events_v2(organization_id,record_id,collection,action,from_status,to_status,actor_user_id,comment)
  values(p_organization_id,source_row.id,p_collection,action_value,current_status,next_status,auth.uid(),nullif(btrim(coalesce(p_comment,'')),''));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,safe_context)
  values(p_organization_id,auth.uid(),'approval.'||lower(action_value),p_collection,source_row.id,
    jsonb_build_object('status',current_status),jsonb_build_object('status',next_status),
    jsonb_build_object('source','transition_approval_v2','requestType',nullif(request_type,'')));

  target_user:=public.approval_user_for_legacy_subject_v2(coalesce(source_data->>'requestedBy',source_data->>'createdBy'));
  if target_user is not null and target_user<>auth.uid() and exists (
    select 1 from public.organization_members m
    join public.profiles p on p.id=m.user_id
    join public.organizations o on o.id=m.organization_id
    where m.organization_id=p_organization_id and m.user_id=target_user
      and m.status='ACTIVE' and p.identity_status='ACTIVE' and o.status='ACTIVE'
  ) then
    insert into public.user_notifications_v2(
      organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key
    ) values (
      p_organization_id,target_user,'APPROVAL_'||action_value,
      case when action_value='APPROVE' then 'SUCCESS' when action_value='REJECT' then 'WARNING' else 'INFO' end,
      case when action_value='APPROVE' then 'Request approved' when action_value='REJECT' then 'Request rejected' else 'Changes requested' end,
      left(coalesce(source_data->>'title',source_data->>'invoiceNumber',p_collection)||case when nullif(btrim(coalesce(p_comment,'')),'') is null then '' else ' — '||btrim(p_comment) end,2000),
      case when p_collection='approvalRequests' then 'requests' else p_collection end,p_collection,source_row.id,
      'approval:'||p_collection||':'||source_row.id||':'||action_value
    ) on conflict do nothing;
  end if;

  return jsonb_build_object('ok',true,'collection',p_collection,'id',source_row.id,'status',next_status,'changes',changes);
exception
  when invalid_text_representation then
    raise exception using errcode='22023',message='approval_data_invalid';
end;
$$;

revoke all on function public.approval_user_for_legacy_subject_v2(text) from public,anon,authenticated;
grant execute on function public.approval_user_for_legacy_subject_v2(text) to service_role;
commit;
-- Roll back application usage if needed; retain this fail-closed identity repair.
-- No business rows or historical events are altered by this migration.
