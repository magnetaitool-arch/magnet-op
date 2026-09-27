-- Reuse the canonical Sales notification for its assigned recipient.
-- No historical notifications or business rows are deleted or backfilled.
begin;
create trigger notification_email_type_v2 after update of notification_type on public.user_notifications_v2
 for each row when(old.notification_type is distinct from new.notification_type)
 execute function public.queue_notification_email_v2();
create or replace function public.submit_website_lead_v2(p_organization_id uuid,p_payload jsonb,p_idempotency_key text,p_request_hash text,p_fingerprint_hash text)
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
  if exists(select 1 from public.user_notifications_v2 n where n.organization_id=p_organization_id and n.recipient_user_id=assigned and n.entity_type='leads' and n.entity_id=legacy_id) then
   update public.user_notifications_v2 set notification_type='LEAD_ASSIGNED'
   where organization_id=p_organization_id and recipient_user_id=assigned and entity_type='leads' and entity_id=legacy_id;
  else
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,title,message,route,entity_type,entity_id,source_key)
  values(p_organization_id,assigned,'LEAD_ASSIGNED','New website lead',coalesce(p_payload->>'company',p_payload->>'name'),'leads','leads',legacy_id,'website:'||legacy_id);
  end if;
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
commit;
