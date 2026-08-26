-- MAGNET OS V2 / M11: server-authoritative approval transitions.
--
-- The legacy UI previously changed approval state optimistically and reported
-- success before PostgREST confirmed the write. This command locks the source
-- record, validates the live tenant membership/capabilities, rejects stale
-- decisions, applies required linked-record effects in the same transaction,
-- and emits an append-only event plus a personal notification.

begin;

create table if not exists public.approval_events_v2 (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  record_id text not null,
  collection text not null check (collection in ('approvalRequests','deliverables','proposals','invoices')),
  action text not null check (action in ('APPROVE','REJECT','REQUEST_CHANGES')),
  from_status text not null,
  to_status text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  comment text,
  occurred_at timestamptz not null default now()
);

create index if not exists approval_events_v2_record_idx
  on public.approval_events_v2(organization_id,collection,record_id,occurred_at desc);

create or replace function public.approval_user_for_legacy_subject_v2(p_subject text)
returns uuid
language sql
stable
security definer
set search_path=''
as $$
  select coalesce(
    (select profile.id from public.profiles profile where profile.id::text=p_subject limit 1),
    (select profile.id from public.profiles profile where profile.employee_id=p_subject limit 1),
    (select link.auth_user_id from public.legacy_identity_links link
      where link.link_status='CONFIRMED'
        and (link.legacy_account_row_id=p_subject or link.employee_record_id=p_subject)
      limit 1)
  );
$$;

create or replace function public.approval_events_v2_append_only()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  raise exception using errcode='42501',message='approval_events_append_only';
end;
$$;

drop trigger if exists approval_events_v2_no_mutation on public.approval_events_v2;
create trigger approval_events_v2_no_mutation
  before update or delete on public.approval_events_v2
  for each row execute function public.approval_events_v2_append_only();

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
  if target_user is not null and target_user<>auth.uid() then
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

alter table public.approval_events_v2 enable row level security;
revoke all privileges on public.approval_events_v2 from public,anon,authenticated;
grant select,insert,update,delete on public.approval_events_v2 to service_role;
grant select on public.approval_events_v2 to authenticated;
grant usage,select on sequence public.approval_events_v2_id_seq to service_role;

drop policy if exists approval_events_v2_authorized_read on public.approval_events_v2;
create policy approval_events_v2_authorized_read on public.approval_events_v2
  for select to authenticated
  using (public.has_org_capability(organization_id,'approvals.manage')
    or public.has_org_capability(organization_id,'hr.manage')
    or public.has_org_capability(organization_id,'finance.manage'));

revoke all on function public.approval_user_for_legacy_subject_v2(text) from public,anon,authenticated;
revoke all on function public.transition_approval_v2(uuid,text,text,text,text,text) from public,anon;
grant execute on function public.approval_user_for_legacy_subject_v2(text) to service_role;
grant execute on function public.transition_approval_v2(uuid,text,text,text,text,text) to authenticated,service_role;

insert into public.migration_audit(migration,note) values(
  '20260826065142_approval_commands_v2',
  'Added server-authoritative, capability-checked, stale-safe approval transitions with transactional linked effects, append-only events, audit records, personal notifications, and no Production application changes.'
);

commit;

-- Forward-only rollback: route the UI back to the legacy approval handlers and
-- revoke authenticated execution of transition_approval_v2. Preserve events and
-- audit history; never delete accepted decisions.
