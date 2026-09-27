begin;
create table public.website_lead_rules_v2 (
 organization_id uuid primary key references public.organizations(id) on delete restrict,
 default_owner_user_id uuid, followup_hours integer check(followup_hours between 1 and 720),
 qualification text not null default 'Nurture' check(qualification in ('Priority','Qualified','Nurture')),
 configured_by uuid not null references public.profiles(id) on delete restrict,
 updated_at timestamptz not null default now(),
 foreign key(organization_id,default_owner_user_id) references public.organization_members(organization_id,user_id) on delete restrict
);
alter table public.website_lead_rules_v2 enable row level security;
revoke all on public.website_lead_rules_v2 from public,anon,authenticated;
grant all on public.website_lead_rules_v2 to service_role;
create function public.website_lead_rules_v2(p_organization_id uuid,p_save boolean default false,p_owner uuid default null,p_followup_hours integer default null,p_qualification text default 'Nurture')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.has_org_capability(p_organization_id,'clients.manage') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='sales_manage_required'; end if;
 if p_save then
  if p_owner is not null and not exists(select 1 from public.organization_members m join public.profiles p on p.id=m.user_id join public.organization_roles r on r.id=m.role_id and r.organization_id=m.organization_id
   where m.organization_id=p_organization_id and m.user_id=p_owner and m.status='ACTIVE' and p.identity_status='ACTIVE' and r.key<>'client' and exists(select 1 from public.role_capabilities rc join public.capabilities c on c.id=rc.capability_id where rc.role_id=m.role_id and c.key='clients.read')) then raise exception using errcode='22023',message='ineligible_owner'; end if;
  if p_followup_hours is not null and p_owner is null then raise exception using errcode='22023',message='followup_requires_owner'; end if;
  insert into public.website_lead_rules_v2(organization_id,default_owner_user_id,followup_hours,qualification,configured_by) values(p_organization_id,p_owner,p_followup_hours,p_qualification,auth.uid())
  on conflict(organization_id) do update set default_owner_user_id=excluded.default_owner_user_id,followup_hours=excluded.followup_hours,qualification=excluded.qualification,configured_by=auth.uid(),updated_at=now();
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id) values(p_organization_id,auth.uid(),'WEBSITE_LEAD_RULE_UPDATED','organization',p_organization_id::text);
 end if;
 return jsonb_build_object('ok',true,'rule',(select to_jsonb(r) from public.website_lead_rules_v2 r where organization_id=p_organization_id),
 'owners',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name)) from public.organization_members m join public.profiles p on p.id=m.user_id join public.organization_roles r on r.id=m.role_id and r.organization_id=m.organization_id
 where m.organization_id=p_organization_id and m.status='ACTIVE' and p.identity_status='ACTIVE' and r.key<>'client' and exists(select 1 from public.role_capabilities rc join public.capabilities c on c.id=rc.capability_id where rc.role_id=m.role_id and c.key='clients.read')),'[]'));
end $$;
revoke all on function public.website_lead_rules_v2(uuid,boolean,uuid,integer,text) from public,anon;
grant execute on function public.website_lead_rules_v2(uuid,boolean,uuid,integer,text) to authenticated;

-- One row per website submission; ambiguity preserves both submissions, never merges people.
create table public.website_lead_receipts_v2 (
 organization_id uuid not null references public.organizations(id) on delete restrict,
 submission_key text not null, request_hash text not null,payload jsonb not null,
 lead_id uuid not null,legacy_record_id text not null,
 review_required boolean not null default false,match_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),primary key(organization_id,submission_key),
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete restrict
);
alter table public.website_lead_receipts_v2 enable row level security;
revoke all on public.website_lead_receipts_v2 from public,anon,authenticated;
grant select,insert on public.website_lead_receipts_v2 to service_role;
create policy website_receipts_sales_read on public.website_lead_receipts_v2 for select to authenticated using(public.has_org_capability(organization_id,'clients.read') and public.current_member_role_key(organization_id)<>'client');
grant select on public.website_lead_receipts_v2 to authenticated;
create index website_receipts_recent_idx on public.website_lead_receipts_v2(organization_id,created_at);
create function public.submit_website_lead_v2(p_organization_id uuid,p_payload jsonb,p_idempotency_key text,p_request_hash text,p_fingerprint_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.website_lead_receipts_v2%rowtype; matching uuid[]; result jsonb; lead_uuid uuid; legacy_id text;
 rule public.website_lead_rules_v2%rowtype; assigned uuid; owner_employee text; email_value text:=lower(btrim(coalesce(p_payload->>'email',''))); phone_value text:=regexp_replace(coalesce(p_payload->>'phone',''),'[^0-9]','','g');
begin
 if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 or p_payload is null or jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>100000 then raise exception using errcode='22023',message='invalid_submission'; end if;
 -- Serialize matching within this tenant: modest public form volume; no cross-tenant lock.
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':website-leads',0));
 select * into prior from public.website_lead_receipts_v2 where organization_id=p_organization_id and submission_key=p_idempotency_key;
 if found then
  if prior.request_hash<>p_request_hash then raise exception using errcode='22023',message='idempotency_conflict'; end if;
  return jsonb_build_object('ok',true,'id',prior.legacy_record_id,'crmLeadId',prior.lead_id,'replayed',true,'reviewRequired',prior.review_required);
 end if;
 -- Exact normalized content replay within 10 minutes may reuse a lead; no fuzzy merging.
 select * into prior from public.website_lead_receipts_v2 where organization_id=p_organization_id and request_hash=p_request_hash and payload=p_payload and created_at>now()-interval '10 minutes' order by created_at desc limit 1;
 if found then
  insert into public.website_lead_receipts_v2(organization_id,submission_key,request_hash,payload,lead_id,legacy_record_id,review_required,match_ids) values(p_organization_id,p_idempotency_key,p_request_hash,p_payload,prior.lead_id,prior.legacy_record_id,prior.review_required,prior.match_ids);
  return jsonb_build_object('ok',true,'id',prior.legacy_record_id,'crmLeadId',prior.lead_id,'replayed',true,'reviewRequired',prior.review_required);
 end if;
 select array_agg(id) into matching from public.crm_leads where organization_id=p_organization_id and deleted_at is null and submitted_at>now()-interval '30 days'
 and ((email_value<>'' and email_normalized=email_value) or (phone_value<>'' and regexp_replace(coalesce(phone,''),'[^0-9]','','g')=phone_value));
 result:=public.submit_public_intake(p_organization_id,'lead',p_payload||jsonb_build_object('duplicateReviewRequired',coalesce(cardinality(matching),0)>0),p_idempotency_key,p_request_hash,p_fingerprint_hash);
 legacy_id:=result->>'id';
 select id into lead_uuid from public.crm_leads where organization_id=p_organization_id and legacy_record_id=legacy_id;
 if lead_uuid is null then raise exception 'lead_projection_missing'; end if;
 select * into rule from public.website_lead_rules_v2 where organization_id=p_organization_id;
 select m.user_id,p.employee_id into assigned,owner_employee from public.organization_members m join public.profiles p on p.id=m.user_id join public.organization_roles r on r.id=m.role_id and r.organization_id=m.organization_id
 where m.organization_id=p_organization_id and m.user_id=rule.default_owner_user_id and m.status='ACTIVE' and p.identity_status='ACTIVE' and r.key<>'client'
 and exists(select 1 from public.role_capabilities rc join public.capabilities c on c.id=rc.capability_id where rc.role_id=m.role_id and c.key='clients.read');
 update public.records set data=data||jsonb_build_object('qualification',coalesce(rule.qualification,'Nurture'),'assignedAuthUserId',assigned,'ownerId',owner_employee)
 where organization_id=p_organization_id and coll='leads' and id=legacy_id;
 if assigned is not null then
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,title,message,route,entity_type,entity_id,source_key)
  values(p_organization_id,assigned,'LEAD_ASSIGNED','New website lead',coalesce(p_payload->>'company',p_payload->>'name'),'leads','leads',legacy_id,'website:'||legacy_id);
  if rule.followup_hours is not null and rule.qualification in ('Priority','Qualified') then
   insert into public.crm_followups_v2(id,organization_id,lead_id,owner_user_id,title,due_at,source_timezone,created_by)
   values(gen_random_uuid(),p_organization_id,lead_uuid,assigned,'Review website enquiry',now()+make_interval(hours=>rule.followup_hours),'UTC',rule.configured_by);
  end if;
 end if;
 insert into public.website_lead_receipts_v2(organization_id,submission_key,request_hash,payload,lead_id,legacy_record_id,review_required,match_ids)
 values(p_organization_id,p_idempotency_key,p_request_hash,p_payload,lead_uuid,legacy_id,coalesce(cardinality(matching),0)>0,coalesce(matching,'{}'));
 insert into public.audit_events(organization_id,action,entity_type,entity_id,safe_context)
 values(p_organization_id,'WEBSITE_LEAD_SUBMITTED','lead',lead_uuid::text,jsonb_build_object('assigned',assigned is not null,'reviewRequired',coalesce(cardinality(matching),0)>0,'ruleConfiguredBy',rule.configured_by));
 return jsonb_build_object('ok',true,'id',legacy_id,'crmLeadId',lead_uuid,'replayed',false,'reviewRequired',coalesce(cardinality(matching),0)>0);
end $$;
revoke all on function public.submit_website_lead_v2(uuid,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_website_lead_v2(uuid,jsonb,text,text,text) to service_role;
commit;
