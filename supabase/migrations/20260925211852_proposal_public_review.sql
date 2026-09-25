-- Bearer-capability links expose an explicit public offer, never the internal record.
begin;
create table if not exists public.proposal_review_links_v2 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,revision_id uuid not null,
 token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),
 created_by uuid not null references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),expires_at timestamptz not null,
 revoked_at timestamptz,accepted_at timestamptz,respondent_name text,respondent_email text,
 foreign key(organization_id,revision_id) references public.proposal_revisions_v2(organization_id,id) on delete restrict
);
create index if not exists proposal_review_links_v2_revision on public.proposal_review_links_v2(organization_id,revision_id,created_at desc);
alter table public.proposal_review_links_v2 enable row level security;
revoke all on public.proposal_review_links_v2 from anon,authenticated;
grant all on public.proposal_review_links_v2 to service_role;

create or replace function public.manage_proposal_review_link_v2(p_organization_id uuid,p_revision_id uuid,p_action text,p_link_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.proposal_revisions_v2%rowtype;proposal public.records%rowtype;raw_token text;link public.proposal_review_links_v2%rowtype;expiry timestamptz;
begin
 if not public.has_org_capability(p_organization_id,'clients.manage') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='proposal_manage_required';end if;
 select * into proposal from public.records where organization_id=p_organization_id and id=(select record_id from public.proposal_revisions_v2 where organization_id=p_organization_id and id=p_revision_id) and deleted_at is null for update;
 select * into r from public.proposal_revisions_v2 where organization_id=p_organization_id and id=p_revision_id for update;
 if proposal.id is null or r.id is null then raise exception 'proposal_not_found';end if;
 if p_action='LIST' then
  return jsonb_build_object('ok',true,'links',coalesce((select jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'expiresAt',expires_at,'revokedAt',revoked_at,'acceptedAt',accepted_at) order by created_at desc) from public.proposal_review_links_v2 where organization_id=p_organization_id and revision_id=p_revision_id),'[]'::jsonb));
 elsif p_action='REVOKE' then
  update public.proposal_review_links_v2 set revoked_at=coalesce(revoked_at,now()) where organization_id=p_organization_id and revision_id=p_revision_id and id=p_link_id;
  if not found then raise exception 'review_link_not_found';end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'PROPOSAL_REVIEW_LINK_REVOKED','proposal',proposal.id,jsonb_build_object('linkId',p_link_id));
  return jsonb_build_object('ok',true);
 elsif p_action<>'CREATE' or p_action is null then raise exception 'invalid_link_action';end if;
 if r.state not in('APPROVED','SENT') or public.proposal_content_hash_v2(proposal.data)<>r.source_hash then raise exception 'approved_revision_required';end if;
 expiry=least(now()+interval '72 hours',((r.snapshot->>'validUntil')::date+1)::timestamp at time zone 'UTC');
 if expiry<=now() then raise exception 'proposal_expired';end if;
 if (select count(*) from public.proposal_review_links_v2 where organization_id=p_organization_id and revision_id=r.id and revoked_at is null and expires_at>now())>=5 then raise exception 'revoke_unused_links_first';end if;
 raw_token=encode(extensions.gen_random_bytes(32),'hex');
 insert into public.proposal_review_links_v2(organization_id,revision_id,token_hash,created_by,expires_at)
 values(p_organization_id,r.id,encode(extensions.digest(raw_token,'sha256'),'hex'),auth.uid(),expiry) returning * into link;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'PROPOSAL_REVIEW_LINK_CREATED','proposal',proposal.id,jsonb_build_object('linkId',link.id,'revisionId',r.id,'expiresAt',expiry));
 return jsonb_build_object('ok',true,'id',link.id,'token',raw_token,'expiresAt',expiry);
end;$$;

create or replace function public.get_public_proposal_v2(p_token text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare link public.proposal_review_links_v2%rowtype;r public.proposal_revisions_v2%rowtype;public_fields jsonb;
begin
 if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','review_unavailable');end if;
 select * into link from public.proposal_review_links_v2 where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and revoked_at is null and expires_at>now();
 if link.id is null then return jsonb_build_object('ok',false,'error','review_unavailable');end if;
 select revision.* into r from public.proposal_revisions_v2 revision join public.records record on record.id=revision.record_id and record.organization_id=revision.organization_id
 join public.organizations organization on organization.id=revision.organization_id and organization.status='ACTIVE'
 where revision.id=link.revision_id and revision.organization_id=link.organization_id and revision.state in('APPROVED','SENT','ACCEPTED') and record.deleted_at is null
 and public.proposal_content_hash_v2(record.data)=revision.source_hash;
 if r.id is null then return jsonb_build_object('ok',false,'error','review_unavailable');end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into public_fields from jsonb_each(r.snapshot)
 where key=any(array['title','proposalNumber','revisionNumber','preparedFor','issueDate','validUntil','currency','price','scope','scopeOfWork','deliverables','timeline','executiveSummary','clientSituation','goals','strategy','paymentTerms','revisionPolicy','exclusions','nextSteps']);
 return jsonb_build_object('ok',true,'proposal',public_fields,'revisionId',r.id,'contentHash',r.content_hash,'state',r.state,'expiresAt',link.expires_at,'acceptedAt',link.accepted_at);
end;$$;

create or replace function public.accept_public_proposal_v2(p_token text,p_content_hash text,p_name text,p_email text,p_confirm boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare link public.proposal_review_links_v2%rowtype;r public.proposal_revisions_v2%rowtype;proposal public.records%rowtype;public_result jsonb;
begin
 if p_confirm is distinct from true or char_length(btrim(coalesce(p_name,''))) not between 2 and 160
 or char_length(btrim(coalesce(p_email,''))) not between 3 and 320 or btrim(coalesce(p_email,''))!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return jsonb_build_object('ok',false,'error','acceptance_details_required');end if;
 if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','review_unavailable');end if;
 -- Match staff lock order: source → revision → link, avoiding revoke/accept deadlocks.
 select * into link from public.proposal_review_links_v2 where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
 if link.id is null then return jsonb_build_object('ok',false,'error','review_unavailable');end if;
 select * into proposal from public.records where organization_id=link.organization_id and id=(select record_id from public.proposal_revisions_v2 where id=link.revision_id) and deleted_at is null for update;
 select * into r from public.proposal_revisions_v2 where organization_id=link.organization_id and id=link.revision_id for update;
 select * into link from public.proposal_review_links_v2 where id=link.id for update;
 public_result=public.get_public_proposal_v2(p_token);
 if public_result->>'ok'<>'true' or r.content_hash is distinct from p_content_hash then return jsonb_build_object('ok',false,'error','review_unavailable');end if;
 if r.state='ACCEPTED' then return jsonb_build_object('ok',true,'alreadyAccepted',true);end if;
 update public.proposal_review_links_v2 set accepted_at=now(),respondent_name=btrim(p_name),respondent_email=lower(btrim(p_email)) where id=link.id;
 update public.proposal_revisions_v2 set state='ACCEPTED',version=version+1 where id=r.id;
 insert into public.proposal_revision_events_v2(organization_id,revision_id,from_state,to_state,evidence)
 values(r.organization_id,r.id,r.state,'ACCEPTED','Acceptance submitted through an active client review link. Respondent details are stored in the restricted link record.');
 perform set_config('app.proposal_revision_command','1',true);
 update public.records set data=data||jsonb_build_object('status','Accepted','acceptedAt',now(),'updatedAt',now()),updated_at=now() where id=proposal.id;
 insert into public.audit_events(organization_id,action,entity_type,entity_id,safe_context) values(r.organization_id,'PROPOSAL_CLIENT_LINK_ACCEPTED','proposal',proposal.id,jsonb_build_object('revisionId',r.id,'contentHash',r.content_hash,'linkId',link.id,'identityAssurance','LINK_HOLDER_SELF_DECLARED'));
 return jsonb_build_object('ok',true,'alreadyAccepted',false);
end;$$;
revoke all on function public.manage_proposal_review_link_v2(uuid,uuid,text,uuid),public.get_public_proposal_v2(text),public.accept_public_proposal_v2(text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.manage_proposal_review_link_v2(uuid,uuid,text,uuid) to authenticated,service_role;
grant execute on function public.get_public_proposal_v2(text),public.accept_public_proposal_v2(text,text,text,text,boolean) to anon,authenticated,service_role;
commit;
