-- Connect accepted immutable commercial scope to existing client/discovery records.
-- No historical backfill; no contract, payment or execution gate is bypassed.
begin;
create table public.proposal_handoffs_v2 (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete restrict,
 revision_id uuid not null unique,
 client_account_id uuid not null, workflow_record_id text not null,
 created_by uuid not null references public.profiles(id) on delete restrict, created_at timestamptz not null default now(),
 foreign key(organization_id,revision_id) references public.proposal_revisions_v2(organization_id,id) on delete restrict,
 foreign key(organization_id,client_account_id) references public.client_accounts(organization_id,id) on delete restrict,
 foreign key(organization_id,workflow_record_id) references public.records(organization_id,id) on delete restrict
);
alter table public.proposal_handoffs_v2 enable row level security;
revoke all on public.proposal_handoffs_v2 from public,anon,authenticated;
grant select on public.proposal_handoffs_v2 to authenticated;
grant select,insert on public.proposal_handoffs_v2 to service_role;
create policy proposal_handoffs_read on public.proposal_handoffs_v2 for select to authenticated
 using(public.has_org_capability(organization_id,'clients.read') and public.current_member_role_key(organization_id)<>'client');

create or replace function public.handoff_accepted_proposal_v2(p_organization_id uuid,p_revision_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r public.proposal_revisions_v2%rowtype; proposal public.records%rowtype;
 h public.proposal_handoffs_v2%rowtype; client_row public.client_accounts%rowtype;
 lead_row public.crm_leads%rowtype; workflow public.records%rowtype;
 result jsonb; ids text[]; workflow_id text;
begin
 if auth.uid() is null or not public.is_active_org_member(p_organization_id)
 or not public.has_org_capability(p_organization_id,'clients.manage')
 or not public.has_org_capability(p_organization_id,'clients.read')
 or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='crm_manage_required';end if;
 -- Same lock order as lead conversion; serialize discovery creation per tenant.
 perform pg_advisory_xact_lock(hashtextextended('lead-conversion:'||p_organization_id::text,0));
 select * into proposal from public.records where organization_id=p_organization_id and coll='proposals'
 and id=(select record_id from public.proposal_revisions_v2 where id=p_revision_id and organization_id=p_organization_id)
 and deleted_at is null for update;
 if proposal.id is null then raise exception 'proposal_not_found';end if;
 select * into r from public.proposal_revisions_v2 where id=p_revision_id and organization_id=p_organization_id for update;
 if r.state<>'ACCEPTED' then raise exception 'accepted_revision_required';end if;
 select * into h from public.proposal_handoffs_v2 where revision_id=p_revision_id;
 if h.id is not null then
  select * into client_row from public.client_accounts where id=h.client_account_id and organization_id=p_organization_id and deleted_at is null and archived_at is null;
  select * into workflow from public.records where id=h.workflow_record_id and organization_id=p_organization_id and coll='workflows' and deleted_at is null;
  if client_row.id is null or workflow.id is null then raise exception 'handoff_relationship_review_required';end if;
  return jsonb_build_object('ok',true,'replayed',true,'handoffId',h.id,'clientId',client_row.legacy_record_id,'workflowId',workflow.id);
 end if;
 if public.proposal_content_hash_v2(proposal.data)<>r.source_hash then raise exception using errcode='40001',message='proposal_content_changed';end if;
 if r.client_account_id is not null then
  select * into client_row from public.client_accounts where id=r.client_account_id and organization_id=p_organization_id and deleted_at is null and archived_at is null for update;
  if client_row.id is null then raise exception 'proposal_client_review_required';end if;
 end if;
 if r.lead_id is not null then
  select * into lead_row from public.crm_leads where id=r.lead_id and organization_id=p_organization_id and deleted_at is null;
  if lead_row.id is null then raise exception 'proposal_lead_review_required';end if;
  -- Never attach an unrelated existing client just because a proposal names both.
  if client_row.id is not null and not exists(select 1 from public.records c join public.records l on l.id=lead_row.legacy_record_id
    where c.id=client_row.legacy_record_id and c.organization_id=p_organization_id and l.organization_id=p_organization_id
    and (c.data->>'leadId'=lead_row.legacy_record_id or l.data->>'convertedClientId'=client_row.legacy_record_id)) then
    raise exception 'proposal_client_lead_review_required';end if;
  if lead_row.stage<>'Won' then
    perform public.change_crm_lead_stage(p_organization_id,lead_row.legacy_record_id,'Won','Accepted proposal revision '||r.revision::text);
  end if;
  select * into lead_row from public.crm_leads where id=r.lead_id;
  result=public.convert_crm_lead_v2(p_organization_id,lead_row.legacy_record_id,lead_row.version);
  select * into client_row from public.client_accounts where organization_id=p_organization_id and legacy_record_id=result->'client'->>'id' and deleted_at is null and archived_at is null;
  if client_row.id is null or (r.client_account_id is not null and r.client_account_id<>client_row.id) then raise exception 'handoff_client_review_required';end if;
 end if;
 if client_row.id is null then raise exception 'handoff_client_required';end if;
 select array_agg(id) into ids from public.records where organization_id=p_organization_id and coll='workflows' and data->>'clientId'=client_row.legacy_record_id;
 if coalesce(cardinality(ids),0)>1 then raise exception 'workflow_link_review_required';end if;
 workflow_id=ids[1];
 if workflow_id is null then
  workflow_id='wf-'||gen_random_uuid()::text;
  insert into public.records(id,coll,organization_id,data) values(workflow_id,'workflows',p_organization_id,
   jsonb_build_object('id',workflow_id,'clientId',client_row.legacy_record_id,'stage',2,'startedAt',now(),'createdAt',now(),'updatedAt',now(),'createdBy',auth.uid(),'notes','',
    'stageHistory',jsonb_build_array(jsonb_build_object('stage',2,'at',now(),'by',auth.uid()))));
 else
  select * into workflow from public.records where id=workflow_id for update;
  if workflow.deleted_at is not null then raise exception 'workflow_link_review_required';end if;
 end if;
 insert into public.proposal_handoffs_v2(organization_id,revision_id,client_account_id,workflow_record_id,created_by)
 values(p_organization_id,r.id,client_row.id,workflow_id,auth.uid()) returning * into h;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
 values(p_organization_id,auth.uid(),'PROPOSAL_DISCOVERY_HANDOFF','proposal_revision',r.id::text,
 jsonb_build_object('handoffId',h.id,'clientAccountId',client_row.id,'workflowRecordId',workflow_id,'contentHash',r.content_hash));
 return jsonb_build_object('ok',true,'replayed',false,'handoffId',h.id,'clientId',client_row.legacy_record_id,'workflowId',workflow_id);
end;
$$;
revoke all on function public.handoff_accepted_proposal_v2(uuid,uuid) from public,anon;
grant execute on function public.handoff_accepted_proposal_v2(uuid,uuid) to authenticated;
create or replace function public.get_proposal_revisions_v2(p_organization_id uuid,p_record_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare proposal public.records%rowtype;
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='proposal_read_required';end if;
 select * into proposal from public.records where organization_id=p_organization_id and id=p_record_id and coll='proposals' and deleted_at is null;
 if proposal.id is null then raise exception 'proposal_not_found';end if;
 return jsonb_build_object('ok',true,'currentHash',public.proposal_content_hash_v2(proposal.data),'record',proposal.data||jsonb_build_object('id',proposal.id),
 'canManage',public.has_org_capability(p_organization_id,'clients.manage'),'canApprove',public.has_org_capability(p_organization_id,'approvals.manage'),
 'revisions',coalesce((select jsonb_agg(to_jsonb(r) order by revision desc) from public.proposal_revisions_v2 r where r.organization_id=p_organization_id and r.record_id=p_record_id),'[]'::jsonb),
 'handoffs',coalesce((select jsonb_agg(jsonb_build_object('revisionId',h.revision_id,'handoffId',h.id,'clientId',c.legacy_record_id,'workflowId',h.workflow_record_id)) from public.proposal_handoffs_v2 h join public.proposal_revisions_v2 r on r.organization_id=h.organization_id and r.id=h.revision_id join public.client_accounts c on c.organization_id=h.organization_id and c.id=h.client_account_id where h.organization_id=p_organization_id and r.record_id=p_record_id and c.deleted_at is null and c.archived_at is null),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from public.proposal_revision_events_v2 e join public.proposal_revisions_v2 r on r.organization_id=e.organization_id and r.id=e.revision_id where r.organization_id=p_organization_id and r.record_id=p_record_id),'[]'::jsonb));
end;$$;

commit;
-- Rollback: disable command/UI; retain handoff rows, clients, workflows and audit history.
