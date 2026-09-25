-- Atomic replacement for the browser's lead -> client -> discovery workflow writes.
-- No production backfill or identity guessing. Execution projects remain gated by
-- the existing accepted-offer/contract/payment workflow.
begin;
create or replace function public.convert_crm_lead_v2(
  p_organization_id uuid,p_legacy_record_id text,p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  lead_record public.records%rowtype;
  client_record public.records%rowtype;
  workflow_record public.records%rowtype;
  current_version integer;
  ids text[];
  client_id text;
  workflow_id text;
  client_data jsonb;
  workflow_data jsonb;
  services jsonb;
  display_name text;
  created boolean:=false;
begin
  if auth.uid() is null or not public.is_active_org_member(p_organization_id)
    or not public.has_org_capability(p_organization_id,'clients.manage')
    or not public.has_org_capability(p_organization_id,'clients.read')
    or public.current_member_role_key(p_organization_id)='client' then
    raise exception using errcode='42501',message='crm_manage_required';
  end if;
  -- Serialize conversion commands in this workspace, including two leads sharing
  -- contact evidence. This does not make arbitrary legacy writes transactional.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-conversion:'||p_organization_id::text,0));
  select * into lead_record from public.records
    where organization_id=p_organization_id and id=p_legacy_record_id and coll='leads'
      and deleted_at is null for update;
  if lead_record.id is null then raise exception using errcode='P0001',message='lead_not_found'; end if;
  select version into current_version from public.crm_leads
    where organization_id=p_organization_id and legacy_record_id=p_legacy_record_id and deleted_at is null;
  if current_version is null then raise exception using errcode='P0001',message='lead_projection_missing'; end if;
  if public.normalize_crm_lead_stage(lead_record.data->>'status')<>'Won' then
    raise exception using errcode='P0001',message='lead_must_be_won';
  end if;
  select array_agg(id) into ids from public.records
    where organization_id=p_organization_id and coll='clients'
      and (id=nullif(lead_record.data->>'convertedClientId','') or data->>'leadId'=p_legacy_record_id);
  if coalesce(cardinality(ids),0)>1 then raise exception using errcode='P0001',message='client_link_review_required'; end if;
  client_id:=ids[1];
  if nullif(lead_record.data->>'convertedClientId','') is not null
    and client_id is distinct from lead_record.data->>'convertedClientId' then
    raise exception using errcode='P0001',message='client_link_review_required';
  end if;
  if client_id is not null then
    select * into client_record from public.records where id=client_id for update;
    if client_record.deleted_at is not null or lower(coalesce(client_record.data->>'status','')) in ('archived','deleted')
      or (nullif(client_record.data->>'leadId','') is not null and client_record.data->>'leadId'<>p_legacy_record_id)
      or not exists(select 1 from public.client_accounts where organization_id=p_organization_id
        and legacy_record_id=client_id and deleted_at is null and archived_at is null) then
      raise exception using errcode='P0001',message='client_link_review_required';
    end if;
    select array_agg(id) into ids from public.records where organization_id=p_organization_id
      and coll='workflows' and data->>'clientId'=client_id;
    if coalesce(cardinality(ids),0)>1 then raise exception using errcode='P0001',message='workflow_link_review_required'; end if;
    workflow_id:=ids[1];
    if workflow_id is not null then
      select * into workflow_record from public.records where id=workflow_id for update;
      if workflow_record.deleted_at is not null then raise exception using errcode='P0001',message='workflow_link_review_required'; end if;
      -- Completed retries return persisted entities without duplicate notifications,
      -- audit events, client updates or workflow advancement.
      if lead_record.data->>'convertedClientId'=client_id then
        return jsonb_build_object('ok',true,'replayed',true,'created',false,
          'client',client_record.data||jsonb_build_object('id',client_id),
          'workflow',workflow_record.data||jsonb_build_object('id',workflow_id),
          'lead',lead_record.data||jsonb_build_object('id',lead_record.id));
      end if;
    end if;
  end if;
  if p_expected_version is null or p_expected_version<>current_version then
    raise exception using errcode='40001',message='lead_version_conflict';
  end if;
  if client_id is null then
    -- Shared contact fields only flag review. They never establish client identity.
    if exists(select 1 from public.records r where r.organization_id=p_organization_id and r.coll='clients'
      and ((nullif(lower(btrim(lead_record.data->>'email')),'') is not null
        and lower(btrim(r.data->>'mainContactEmail'))=lower(btrim(lead_record.data->>'email')))
      or (nullif(regexp_replace(lead_record.data->>'phone','[^0-9]','','g'),'') is not null
        and regexp_replace(r.data->>'mainContactPhone','[^0-9]','','g')=regexp_replace(lead_record.data->>'phone','[^0-9]','','g')))) then
      raise exception using errcode='P0001',message='client_contact_review_required';
    end if;
    display_name:=coalesce(nullif(btrim(lead_record.data->>'company'),''),nullif(btrim(lead_record.data->>'name'),''));
    if display_name is null then raise exception using errcode='P0001',message='client_name_required'; end if;
    services:=case when jsonb_typeof(lead_record.data->'serviceInterest')='array' then lead_record.data->'serviceInterest'
      when nullif(lead_record.data->>'serviceInterest','') is not null then jsonb_build_array(lead_record.data->>'serviceInterest') else '[]'::jsonb end;
    client_id:='cli-'||gen_random_uuid()::text;
    client_data:=jsonb_build_object('id',client_id,'name',display_name,'brandName',display_name,'brand','Magnet',
      'leadId',p_legacy_record_id,'status','Onboarding',
      'services',services,'serviceType',coalesce(services->>0,''),
      'mainContactName',coalesce(lead_record.data->>'name',''),'mainContactEmail',coalesce(lead_record.data->>'email',''),
      'mainContactPhone',coalesce(lead_record.data->>'phone',''),'mainContactWhatsapp',coalesce(lead_record.data->>'phone',''),
      'salesOwnerId',case when exists(select 1 from public.records e where e.id=lead_record.data->>'ownerId' and e.coll='employees' and e.organization_id=p_organization_id and e.deleted_at is null) then lead_record.data->>'ownerId' else '' end,
      'source',coalesce(lead_record.data->>'source',''),'createdAt',now(),'updatedAt',now(),'createdBy',auth.uid());
    -- A lead's estimated value is not an agreed recurring retainer. Preserve it
    -- on the lead; commercial pricing requires an accepted proposal.
    insert into public.records(id,coll,organization_id,data) values(client_id,'clients',p_organization_id,client_data);
    created:=true;
  else client_data:=client_record.data; end if;
  if workflow_id is null then
    workflow_id:='wf-'||gen_random_uuid()::text;
    workflow_data:=jsonb_build_object('id',workflow_id,'clientId',client_id,'sourceLeadId',p_legacy_record_id,
      'stage',2,'startedAt',now(),'createdAt',now(),'updatedAt',now(),'createdBy',auth.uid(),'notes','',
      'stageHistory',jsonb_build_array(jsonb_build_object('stage',2,'at',now(),'by',auth.uid())));
    insert into public.records(id,coll,organization_id,data) values(workflow_id,'workflows',p_organization_id,workflow_data);
  else workflow_data:=workflow_record.data; end if;
  update public.records set data=data||jsonb_build_object('convertedClientId',client_id,'convertedAt',now(),'updatedAt',now()),updated_at=now()
    where id=p_legacy_record_id returning * into lead_record;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
    values(p_organization_id,auth.uid(),'CRM_LEAD_CONVERTED','crm_lead',p_legacy_record_id,
      jsonb_build_object('clientRecordId',client_id,'workflowRecordId',workflow_id,'createdClient',created));
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    select p_organization_id,member.user_id,'CLIENT_ONBOARDING','INFO','Client ready for discovery',
      'Review the brief, proposal, contract and first payment before execution.','accounts','clients',client_id,
      'lead-converted:'||p_legacy_record_id
    from public.organization_members member join public.organization_roles role on role.id=member.role_id and role.organization_id=member.organization_id
    where member.organization_id=p_organization_id and member.status='ACTIVE'
      and (member.user_id=auth.uid() or role.key='account_manager') on conflict do nothing;
  return jsonb_build_object('ok',true,'replayed',false,'created',created,
    'client',client_data||jsonb_build_object('id',client_id),
    'workflow',workflow_data||jsonb_build_object('id',workflow_id),
    'lead',lead_record.data||jsonb_build_object('id',lead_record.id));
end;
$$;
revoke all on function public.convert_crm_lead_v2(uuid,text,integer) from public,anon;
grant execute on function public.convert_crm_lead_v2(uuid,text,integer) to authenticated;
commit;
