-- Immutable commercial snapshots; existing proposals are retained and enrolled explicitly.
begin;
create unique index if not exists records_org_id_ref_v2 on public.records(organization_id,id);
create table if not exists public.proposal_revisions_v2 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete restrict,
 record_id text not null,revision integer not null check(revision>0),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),source_hash text not null check(source_hash~'^[a-f0-9]{64}$'),content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 lead_id uuid,client_account_id uuid,
 state text not null default 'DRAFT' check(state in('DRAFT','REVIEW','APPROVED','SENT','ACCEPTED','DECLINED','SUPERSEDED')),
 version integer not null default 1 check(version>0),created_by uuid not null references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),
 unique(organization_id,record_id,revision),unique(organization_id,id),
 foreign key(organization_id,record_id) references public.records(organization_id,id) on delete restrict,
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete restrict,
 foreign key(organization_id,client_account_id) references public.client_accounts(organization_id,id) on delete restrict,
 check(lead_id is not null or client_account_id is not null)
);
create table if not exists public.proposal_revision_events_v2 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,revision_id uuid not null,
 from_state text,to_state text not null,actor_user_id uuid references public.profiles(id) on delete restrict,
 evidence text,created_at timestamptz not null default now(),
 foreign key(organization_id,revision_id) references public.proposal_revisions_v2(organization_id,id) on delete restrict
);
create table if not exists public.proposal_commands_v2 (
 organization_id uuid not null references public.organizations(id) on delete restrict,command_id uuid not null,
 actor_user_id uuid not null references public.profiles(id) on delete restrict,request jsonb not null,result jsonb not null,created_at timestamptz not null default now(),primary key(organization_id,command_id)
);
alter table public.proposal_revisions_v2 enable row level security;
alter table public.proposal_revision_events_v2 enable row level security;
alter table public.proposal_commands_v2 enable row level security;
revoke all on public.proposal_revisions_v2,public.proposal_revision_events_v2,public.proposal_commands_v2 from anon,authenticated;
grant select on public.proposal_revisions_v2,public.proposal_revision_events_v2 to authenticated;
grant all on public.proposal_revisions_v2,public.proposal_revision_events_v2,public.proposal_commands_v2 to service_role;
create policy proposal_revision_read on public.proposal_revisions_v2 for select to authenticated using(public.has_org_capability(organization_id,'clients.read') and public.current_member_role_key(organization_id)<>'client');
create policy proposal_revision_events_read on public.proposal_revision_events_v2 for select to authenticated using(public.has_org_capability(organization_id,'clients.read') and public.current_member_role_key(organization_id)<>'client');

create or replace function public.proposal_content_hash_v2(p_data jsonb)
returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest((p_data-array['status','updatedAt','updatedBy','approvedAt','approvedBy','sentAt','acceptedAt','acceptedBy','_proposalRevision'])::text,'sha256'),'hex');
$$;
create or replace function public.guard_proposal_revision_v2()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='42501',message='proposal_history_is_immutable';end if;
 if (new.id,new.organization_id,new.record_id,new.revision,new.snapshot,new.source_hash,new.content_hash,new.lead_id,new.client_account_id,new.created_by,new.created_at)
  is distinct from(old.id,old.organization_id,old.record_id,old.revision,old.snapshot,old.source_hash,old.content_hash,old.lead_id,old.client_account_id,old.created_by,old.created_at) then raise exception using errcode='42501',message='proposal_snapshot_is_immutable';end if;
 return new;
end;$$;
create trigger proposal_revision_immutable before update or delete on public.proposal_revisions_v2 for each row execute function public.guard_proposal_revision_v2();
create trigger proposal_revision_events_immutable before update or delete on public.proposal_revision_events_v2 for each row execute function public.approval_events_v2_append_only();

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
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from public.proposal_revision_events_v2 e join public.proposal_revisions_v2 r on r.organization_id=e.organization_id and r.id=e.revision_id where r.organization_id=p_organization_id and r.record_id=p_record_id),'[]'::jsonb));
end;$$;

create or replace function public.create_proposal_revision_v2(p_organization_id uuid,p_record_id text,p_expected_hash text,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare proposal public.records%rowtype;prior public.proposal_commands_v2%rowtype;requested jsonb;created public.proposal_revisions_v2%rowtype;lead_uuid uuid;client_uuid uuid;result_value jsonb;issue_day date;expiry_day date; revision_number integer; frozen jsonb;
begin
 if not public.has_org_capability(p_organization_id,'clients.manage') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='proposal_manage_required';end if;
 if p_command_id is null then raise exception 'command_id_required';end if;
 requested=jsonb_build_object('action','CREATE','record',p_record_id,'hash',p_expected_hash);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into prior from public.proposal_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then if prior.actor_user_id<>auth.uid() or prior.request<>requested then raise exception 'idempotency_conflict';end if;return prior.result||jsonb_build_object('replayed',true);end if;
 select * into proposal from public.records where organization_id=p_organization_id and id=p_record_id and coll='proposals' and deleted_at is null for update;
 if proposal.id is null then raise exception 'proposal_not_found';end if;
 if public.proposal_content_hash_v2(proposal.data) is distinct from p_expected_hash then raise exception using errcode='40001',message='proposal_content_conflict';end if;
 if nullif(proposal.data->>'leadId','') is not null then
  select id into lead_uuid from public.crm_leads where organization_id=p_organization_id and legacy_record_id=proposal.data->>'leadId' and deleted_at is null;
  if lead_uuid is null then raise exception 'proposal_lead_review_required';end if;
 end if;
 if nullif(proposal.data->>'clientId','') is not null then
  select id into client_uuid from public.client_accounts where organization_id=p_organization_id and legacy_record_id=proposal.data->>'clientId' and deleted_at is null;
  if client_uuid is null then raise exception 'proposal_client_review_required';end if;
 end if;
 if lead_uuid is null and client_uuid is null then raise exception 'proposal_relationship_required';end if;
 if char_length(btrim(coalesce(proposal.data->>'title',''))) not between 1 and 240
 or char_length(btrim(coalesce(proposal.data->>'scopeOfWork',proposal.data->>'scope','')))=0
 or coalesce(proposal.data->>'currency','')!~'^[A-Z]{3}$'
 or coalesce(proposal.data->>'price','')!~'^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'proposal_title_scope_currency_price_required';end if;
 if octet_length(proposal.data::text)>200000 or (proposal.data->>'price')::numeric>999999999999.99 then raise exception 'proposal_size_or_price_limit';end if;
 issue_day=(proposal.data->>'issueDate')::date;expiry_day=(proposal.data->>'validUntil')::date;
 if issue_day is null or expiry_day is null or not isfinite(issue_day) or not isfinite(expiry_day) or expiry_day<issue_day then raise exception 'proposal_validity_required';end if;
 select coalesce(max(revision),0)+1 into revision_number from public.proposal_revisions_v2 where organization_id=p_organization_id and record_id=p_record_id;
 frozen=proposal.data||jsonb_build_object('revisionNumber',revision_number,'preparedFor',coalesce((select display_name from public.client_accounts where id=client_uuid),(select display_name from public.crm_leads where id=lead_uuid)));
 insert into public.proposal_revisions_v2(organization_id,record_id,revision,snapshot,source_hash,content_hash,lead_id,client_account_id,created_by)
 values(p_organization_id,p_record_id,revision_number,frozen,p_expected_hash,encode(extensions.digest(frozen::text,'sha256'),'hex'),lead_uuid,client_uuid,auth.uid()) returning * into created;
 insert into public.proposal_revision_events_v2(organization_id,revision_id,from_state,to_state,actor_user_id) select organization_id,id,state,'SUPERSEDED',auth.uid() from public.proposal_revisions_v2 where organization_id=p_organization_id and record_id=p_record_id and id<>created.id and state in('DRAFT','REVIEW','APPROVED','SENT');
 update public.proposal_revisions_v2 set state='SUPERSEDED',version=version+1 where organization_id=p_organization_id and record_id=p_record_id and id<>created.id and state in('DRAFT','REVIEW','APPROVED','SENT');
 insert into public.proposal_revision_events_v2(organization_id,revision_id,to_state,actor_user_id) values(p_organization_id,created.id,'DRAFT',auth.uid());
 perform set_config('app.proposal_revision_command','1',true);
 update public.records set data=data||jsonb_build_object('status','Draft','_proposalRevision',created.revision,'updatedAt',now()),updated_at=now() where id=proposal.id;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'PROPOSAL_REVISION_CREATED','proposal',p_record_id,jsonb_build_object('revisionId',created.id,'contentHash',created.content_hash));
 result_value=public.get_proposal_revisions_v2(p_organization_id,p_record_id)||jsonb_build_object('createdRevisionId',created.id);
 insert into public.proposal_commands_v2(organization_id,command_id,actor_user_id,request,result) values(p_organization_id,p_command_id,auth.uid(),requested,result_value);
 return result_value;
end;$$;

create or replace function public.transition_proposal_revision_v2(p_organization_id uuid,p_revision_id uuid,p_expected_version integer,p_action text,p_evidence text,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.proposal_revisions_v2%rowtype;proposal public.records%rowtype;requested jsonb;prior public.proposal_commands_v2%rowtype;next_state text;legacy_state text;result_value jsonb;
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='proposal_read_required';end if;
 if p_action in('APPROVE','CHANGES') then
  if not public.has_org_capability(p_organization_id,'approvals.manage') then raise exception using errcode='42501',message='proposal_approval_required';end if;
 elsif not public.has_org_capability(p_organization_id,'clients.manage') then raise exception using errcode='42501',message='proposal_manage_required';end if;
 if p_command_id is null then raise exception 'command_id_required';end if;
 requested=jsonb_build_object('revision',p_revision_id,'version',p_expected_version,'action',p_action,'evidence',p_evidence);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into prior from public.proposal_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then if prior.actor_user_id<>auth.uid() or prior.request<>requested then raise exception 'idempotency_conflict';end if;return prior.result||jsonb_build_object('replayed',true);end if;
 -- Lock the source before the revision, matching snapshot creation lock order.
 select * into proposal from public.records where id=(select record_id from public.proposal_revisions_v2 where organization_id=p_organization_id and id=p_revision_id) and organization_id=p_organization_id and deleted_at is null for update;
 select * into r from public.proposal_revisions_v2 where organization_id=p_organization_id and id=p_revision_id for update;
 if r.id is null or proposal.id is null then raise exception 'proposal_not_found';end if;
 if r.version is distinct from p_expected_version then raise exception using errcode='40001',message='proposal_version_conflict';end if;
 if public.proposal_content_hash_v2(proposal.data)<>r.source_hash then raise exception using errcode='40001',message='proposal_content_changed_create_revision';end if;
 next_state=case when p_action='REVIEW' and r.state='DRAFT' then 'REVIEW' when p_action='APPROVE' and r.state='REVIEW' then 'APPROVED' when p_action='CHANGES' and r.state='REVIEW' then 'DRAFT' when p_action='RECORD_SENT' and r.state='APPROVED' then 'SENT' when p_action='RECORD_ACCEPTED' and r.state='SENT' then 'ACCEPTED' when p_action='RECORD_DECLINED' and r.state='SENT' then 'DECLINED' else null end;
 if next_state is null then raise exception 'invalid_proposal_transition';end if;
 if p_action in('CHANGES','RECORD_SENT','RECORD_ACCEPTED','RECORD_DECLINED') and char_length(btrim(coalesce(p_evidence,''))) not between 10 and 2000 then raise exception 'proposal_evidence_required';end if;
 if p_action in('RECORD_SENT','RECORD_ACCEPTED') and (r.snapshot->>'validUntil')::date<current_date then raise exception 'proposal_expired';end if;
 update public.proposal_revisions_v2 set state=next_state,version=version+1 where id=r.id;
 insert into public.proposal_revision_events_v2(organization_id,revision_id,from_state,to_state,actor_user_id,evidence) values(p_organization_id,r.id,r.state,next_state,auth.uid(),nullif(btrim(p_evidence),''));
 legacy_state=case next_state when 'DRAFT' then 'Draft' when 'REVIEW' then 'Pending Approval' when 'APPROVED' then 'Approved' when 'SENT' then 'Sent' when 'ACCEPTED' then 'Accepted' when 'DECLINED' then 'Rejected' end;
 perform set_config('app.proposal_revision_command','1',true);
 update public.records set data=data||jsonb_build_object('status',legacy_state,'updatedAt',now()),updated_at=now() where id=proposal.id;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'PROPOSAL_REVISION_'||p_action,'proposal',proposal.id,jsonb_build_object('revisionId',r.id,'contentHash',r.content_hash,'source','STAFF_RECORDED'));
 result_value=public.get_proposal_revisions_v2(p_organization_id,proposal.id);
 insert into public.proposal_commands_v2(organization_id,command_id,actor_user_id,request,result) values(p_organization_id,p_command_id,auth.uid(),requested,result_value);
 return result_value;
end;$$;

create or replace function public.guard_versioned_proposal_status_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.coll<>'proposals' or not exists(select 1 from public.proposal_revisions_v2 where organization_id=old.organization_id and record_id=old.id) then return new;end if;
 if new.coll<>old.coll or new.organization_id<>old.organization_id or new.id<>old.id then raise exception using errcode='42501',message='versioned_proposal_identity_is_immutable';end if;
 if coalesce(current_setting('app.proposal_revision_command',true),'')='1' then return new;end if;
 if public.proposal_content_hash_v2(new.data)<>public.proposal_content_hash_v2(old.data) then
  insert into public.proposal_revision_events_v2(organization_id,revision_id,from_state,to_state,actor_user_id,evidence)
  select organization_id,id,state,'SUPERSEDED',auth.uid(),'Working proposal changed; previous approval cannot authorize the changed content.' from public.proposal_revisions_v2 where organization_id=old.organization_id and record_id=old.id and state in('DRAFT','REVIEW','APPROVED','SENT');
  update public.proposal_revisions_v2 set state='SUPERSEDED',version=version+1 where organization_id=old.organization_id and record_id=old.id and state in('DRAFT','REVIEW','APPROVED','SENT');
  new.data=new.data||jsonb_build_object('status','Draft');
 elsif new.data->>'status' is distinct from old.data->>'status' then
  raise exception using errcode='42501',message='proposal_revision_command_required';
 end if;
 return new;
end;$$;
create trigger records_versioned_proposal_status before update on public.records for each row execute function public.guard_versioned_proposal_status_v2();
revoke all on function public.get_proposal_revisions_v2(uuid,text),public.create_proposal_revision_v2(uuid,text,text,uuid),public.transition_proposal_revision_v2(uuid,uuid,integer,text,text,uuid) from public,anon;
grant execute on function public.get_proposal_revisions_v2(uuid,text),public.create_proposal_revision_v2(uuid,text,text,uuid),public.transition_proposal_revision_v2(uuid,uuid,integer,text,text,uuid) to authenticated,service_role;
revoke all on function public.proposal_content_hash_v2(jsonb),public.guard_proposal_revision_v2(),public.guard_versioned_proposal_status_v2() from public,anon,authenticated;
grant execute on function public.proposal_content_hash_v2(jsonb),public.guard_proposal_revision_v2(),public.guard_versioned_proposal_status_v2() to service_role;
commit;
