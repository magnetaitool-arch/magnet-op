-- Incremental workflow authority. Existing rows and history are retained.
begin;
create table public.workflow_commands_v2 (
 organization_id uuid not null references public.organizations(id) on delete restrict,
 command_id uuid not null, actor_user_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,result jsonb not null,created_at timestamptz not null default now(),primary key(organization_id,command_id)
);
alter table public.workflow_commands_v2 enable row level security;
revoke all on public.workflow_commands_v2 from public,anon,authenticated;
grant select,insert on public.workflow_commands_v2 to service_role;

create or replace function public.workflow_readiness_v2(p_organization_id uuid,p_workflow_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w public.records%rowtype;c public.client_accounts%rowtype;d jsonb;s integer;ready boolean:=false;reason text;
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='workflow_read_required';end if;
 select * into w from public.records where organization_id=p_organization_id and id=p_workflow_id and coll='workflows' and deleted_at is null;
 if w.id is null then raise exception 'workflow_not_found';end if;
 select * into c from public.client_accounts where organization_id=p_organization_id and legacy_record_id=w.data->>'clientId' and deleted_at is null and archived_at is null;
 if c.id is null then return jsonb_build_object('ok',true,'ready',false,'reason','client_unavailable','stage',w.data->'stage');end if;
 select data into d from public.records where id=c.legacy_record_id and organization_id=p_organization_id and deleted_at is null;
 if coalesce(w.data->>'stage','')!~'^[0-9]+$' then raise exception 'workflow_stage_invalid';end if;s=(w.data->>'stage')::integer;
 case s
 when 1 then ready=true;reason='client_required';
 when 2 then
  ready=nullif(btrim(coalesce(nullif(d->>'mainContactName',''),nullif(d->>'mainContactEmail',''),d->>'mainContactPhone','')),'') is not null
    and (nullif(btrim(d->>'serviceType'),'') is not null or (case when jsonb_typeof(d->'services')='array' then jsonb_array_length(d->'services')>0 else false end));
  reason='contact_and_service_required';
 when 3 then
  select exists(select 1 from public.proposal_handoffs_v2 h join public.proposal_revisions_v2 r on r.id=h.revision_id and r.organization_id=h.organization_id where h.organization_id=p_organization_id and h.client_account_id=c.id and r.state='ACCEPTED') into ready;
  reason='accepted_revision_handoff_required';
 when 4 then
  select exists(select 1 from public.agency_contracts a where a.organization_id=p_organization_id and a.client_account_id=c.id and a.deleted_at is null and a.archived_at is null and a.status in('Signed','Active') and a.signed_at is not null) into ready;
  reason='signed_contract_required';
 when 5 then
  select exists(select 1 from public.finance_invoices i where i.organization_id=p_organization_id and i.client_account_id=c.id and i.deleted_at is null and i.relationship_state='VALID' and i.stored_status in('Issued','Partially Paid','Paid','Overdue') and i.total>0) into ready;
  reason='issued_invoice_required';
 when 6 then
  select exists(select 1 from public.finance_payments p join public.finance_invoices i on i.id=p.invoice_id and i.organization_id=p.organization_id and i.client_account_id=p.client_account_id where p.organization_id=p_organization_id and p.client_account_id=c.id and p.deleted_at is null and i.deleted_at is null and p.paid_on<=current_date and i.stored_status not in('Draft','Cancelled') and i.relationship_state='VALID') into ready;
  reason='recorded_invoice_payment_required';
 when 7 then
  ready=((case when jsonb_typeof(d->'onboarding')='array' then jsonb_array_length(d->'onboarding')>0 else false end) and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(d->'onboarding')='array' then d->'onboarding' else '[]'::jsonb end) x where x->'done' is distinct from 'true'::jsonb));
  reason='onboarding_checklist_required';
 when 8 then
  select exists(select 1 from public.records p join public.records e on e.id=coalesce(nullif(p.data->>'projectManagerId',''),nullif(p.data->>'ownerId','')) and e.organization_id=p.organization_id and e.coll='employees' and e.deleted_at is null join public.organization_members m on m.organization_id=p.organization_id and m.user_id=public.task_user_for_employee_v2(e.id) and m.status='ACTIVE' join public.profiles owner_profile on owner_profile.id=m.user_id and owner_profile.identity_status='ACTIVE' where p.organization_id=p_organization_id and p.coll='projects' and p.deleted_at is null and p.data->>'clientId'=c.legacy_record_id and coalesce(p.data->>'status','') not in('Cancelled','Archived') and case when pg_input_is_valid(p.data->>'startDate','date') and pg_input_is_valid(coalesce(nullif(p.data->>'deadline',''),p.data->>'dueDate'),'date') then (coalesce(nullif(p.data->>'deadline',''),p.data->>'dueDate'))::date >= (p.data->>'startDate')::date else false end) into ready;
  reason='dated_owned_project_required';
 when 9 then
  select exists(select 1 from public.work_tasks t join public.organization_members m on m.organization_id=t.organization_id and m.user_id=coalesce(t.assigned_user_id,public.task_user_for_employee_v2(t.assigned_employee_record_id)) and m.status='ACTIVE' join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where t.organization_id=p_organization_id and t.client_account_id=c.id and t.deleted_at is null and t.status<>'Cancelled' and t.due_date is not null) into ready;
  reason='dated_active_assignee_task_required';
 when 10 then
  select exists(select 1 from public.work_tasks t where t.organization_id=p_organization_id and t.client_account_id=c.id and t.deleted_at is null and t.status in('In Progress','Internal Review','Client Review','Approved','Delivered','Done')) into ready;
  reason='execution_required';
 when 11 then
  select exists(select 1 from public.records x where x.organization_id=p_organization_id and x.coll='deliverables' and x.deleted_at is null and x.data->>'clientId'=c.legacy_record_id and x.data->>'status' in('Internal Review','Client Review','Revision Requested','Approved','Delivered','Published')) into ready;
  reason='internal_review_required';
 when 12 then
  select exists(select 1 from public.records x where x.organization_id=p_organization_id and x.coll='deliverables' and x.deleted_at is null and x.data->>'clientId'=c.legacy_record_id and x.data->>'status' in('Client Review','Revision Requested','Approved','Delivered','Published')) into ready;
  reason='client_review_required';
 when 13 then
  select exists(select 1 from public.records x where x.organization_id=p_organization_id and x.coll='deliverables' and x.deleted_at is null and x.data->>'clientId'=c.legacy_record_id and x.data->>'status' in('Delivered','Published') and (x.data->>'approvalStatus'='Approved' or exists(select 1 from public.approval_events_v2 e where e.organization_id=x.organization_id and e.record_id=x.id and e.collection='deliverables' and e.action='APPROVE'))) into ready;
  reason='approved_delivery_required';
 when 14 then
  select exists(select 1 from public.records x where x.organization_id=p_organization_id and x.coll='reports' and x.deleted_at is null and x.data->>'clientId'=c.legacy_record_id and coalesce(x.data->>'reportKind','Client')='Client' and x.data->>'status' in('Approved','Sent','Delivered','Published')) into ready;
  reason='reviewed_client_report_required';
 when 15 then ready=true;reason='complete';
 else raise exception 'workflow_stage_invalid';end case;
 return jsonb_build_object('ok',true,'ready',coalesce(ready,false),'reason',reason,'stage',s,'workflow',w.data||jsonb_build_object('id',w.id));
end;$$;

create or replace function public.start_workflow_v2(p_organization_id uuid,p_client_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids text[];w public.records%rowtype;
begin
 if not public.has_org_capability(p_organization_id,'clients.manage') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='workflow_manage_required';end if;
 perform pg_advisory_xact_lock(hashtextextended('lead-conversion:'||p_organization_id::text,0));
 if not exists(select 1 from public.client_accounts where organization_id=p_organization_id and legacy_record_id=p_client_id and deleted_at is null and archived_at is null) then raise exception 'client_unavailable';end if;
 select array_agg(id) into ids from public.records where organization_id=p_organization_id and coll='workflows' and data->>'clientId'=p_client_id;
 if coalesce(cardinality(ids),0)>1 then raise exception 'workflow_link_review_required';end if;
 if ids[1] is not null then select * into w from public.records where id=ids[1];if w.deleted_at is not null then raise exception 'workflow_link_review_required';end if;
 else
  w.id='wf-'||gen_random_uuid()::text;
  insert into public.records(id,coll,organization_id,data) values(w.id,'workflows',p_organization_id,jsonb_build_object('id',w.id,'clientId',p_client_id,'stage',2,'startedAt',now(),'createdAt',now(),'createdBy',auth.uid(),'stageHistory',jsonb_build_array(jsonb_build_object('stage',2,'at',now(),'by',auth.uid())))) returning * into w;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id) values(p_organization_id,auth.uid(),'WORKFLOW_STARTED','workflow',w.id);
 end if;
 return jsonb_build_object('ok',true,'workflow',w.data||jsonb_build_object('id',w.id));
end;$$;

create or replace function public.advance_workflow_v2(p_organization_id uuid,p_workflow_id text,p_expected_stage integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.records%rowtype;check_result jsonb;requested jsonb;prior public.workflow_commands_v2%rowtype;result jsonb;next_stage integer;client_data jsonb;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client'
 or not (public.has_org_capability(p_organization_id,'clients.manage') or public.has_org_capability(p_organization_id,'work.manage')) then raise exception using errcode='42501',message='workflow_manage_required';end if;
 if p_command_id is null then raise exception 'command_id_required';end if;
 requested=jsonb_build_object('workflow',p_workflow_id,'stage',p_expected_stage);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into prior from public.workflow_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then if prior.actor_user_id<>auth.uid() or prior.request<>requested then raise exception 'idempotency_conflict';end if;return prior.result||jsonb_build_object('replayed',true);end if;
 select * into w from public.records where organization_id=p_organization_id and id=p_workflow_id and coll='workflows' and deleted_at is null for update;
 if w.id is null then raise exception 'workflow_not_found';end if;
 if coalesce(w.data->>'stage','')<>p_expected_stage::text or p_expected_stage is null then raise exception using errcode='40001',message='workflow_stage_conflict';end if;
 check_result=public.workflow_readiness_v2(p_organization_id,p_workflow_id);
 if not (check_result->>'ready')::boolean then return check_result||jsonb_build_object('ok',false);end if;
 if p_expected_stage=15 then return jsonb_build_object('ok',true,'complete',true,'workflow',w.data||jsonb_build_object('id',w.id));end if;
 if w.data ? 'stageHistory' and jsonb_typeof(w.data->'stageHistory')<>'array' then raise exception 'workflow_history_review_required';end if;
 next_stage=p_expected_stage+1;
 perform set_config('app.workflow_command','1',true);
 update public.records set data=data||jsonb_build_object('stage',next_stage,'lastValidatedAt',now(),'updatedAt',now(),'stageHistory',coalesce(data->'stageHistory','[]'::jsonb)||jsonb_build_array(jsonb_build_object('stage',next_stage,'at',now(),'by',auth.uid()))),updated_at=now(),updated_by=auth.uid()::text where id=w.id returning * into w;
 if next_stage in(7,8,15) then
  update public.records set data=data||jsonb_build_object('status',case next_stage when 7 then 'Onboarding' when 8 then 'Active' else 'Renewal Needed' end,'updatedAt',now()),updated_at=now() where id=w.data->>'clientId' and organization_id=p_organization_id and coll='clients' and deleted_at is null returning data||jsonb_build_object('id',id) into client_data;
 end if;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'WORKFLOW_ADVANCED','workflow',w.id,jsonb_build_object('from',p_expected_stage,'to',next_stage,'commandId',p_command_id));
 result=jsonb_build_object('ok',true,'stage',next_stage,'workflow',w.data||jsonb_build_object('id',w.id),'client',client_data);
 insert into public.workflow_commands_v2 values(p_organization_id,p_command_id,auth.uid(),requested,result,now());
 return result;
end;$$;

create or replace function public.guard_workflow_stage_v2() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='INSERT' then
  if new.coll='workflows' and auth.uid() is not null and coalesce(new.data->>'stage','2') not in('1','2') then raise exception using errcode='42501',message='workflow_initial_stage_required';end if;
  return new;
 end if;
 if new.coll='workflows' and old.coll<>'workflows' then raise exception using errcode='42501',message='workflow_identity_immutable';end if;
 if old.coll='workflows' and (new.coll,new.organization_id,new.id,new.data->>'clientId') is distinct from (old.coll,old.organization_id,old.id,old.data->>'clientId') then raise exception using errcode='42501',message='workflow_identity_immutable';end if;
 if old.coll='workflows' and (new.data->'stage',new.data->'stageHistory') is distinct from (old.data->'stage',old.data->'stageHistory') and coalesce(current_setting('app.workflow_command',true),'')<>'1' then raise exception using errcode='42501',message='workflow_command_required';end if;
 return new;
end;$$;
create trigger workflow_stage_authority before insert or update on public.records for each row execute function public.guard_workflow_stage_v2();
revoke all on function public.workflow_readiness_v2(uuid,text),public.start_workflow_v2(uuid,text),public.advance_workflow_v2(uuid,text,integer,uuid),public.guard_workflow_stage_v2() from public,anon;
grant execute on function public.workflow_readiness_v2(uuid,text),public.start_workflow_v2(uuid,text),public.advance_workflow_v2(uuid,text,integer,uuid) to authenticated;
commit;
-- Rollback: disable new command/UI. Preserve command ledger, source rows and audit events.
