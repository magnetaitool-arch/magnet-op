-- Additive Studio documents on canonical tasks. No legacy rows rewritten.
-- Rollback: withdraw Studio UI; retain tables/history. Never drop business versions.
begin;
create table public.studio_documents_v2 (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 task_id uuid not null, kind text not null check(kind in ('brief','report','content','design','video')),
 brief_document_id uuid references public.studio_documents_v2(id) on delete restrict,
 campaign_record_id text references public.records(id) on delete restrict,
 revision integer not null default 0 check(revision>=0),
 status text not null default 'DRAFT' check(status in('DRAFT','INTERNAL_REVIEW','REVISION','APPROVED','FINAL')),
 created_by uuid not null references public.profiles(id) on delete restrict,
 updated_at timestamptz not null default now(),
 foreign key(organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict,
 unique(organization_id,id)
);
create table public.studio_versions_v2 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,document_id uuid not null,
 revision integer not null check(revision>0),payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
 file_id uuid references public.document_files(id) on delete restrict,
 created_by uuid not null references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),
 foreign key(organization_id,document_id) references public.studio_documents_v2(organization_id,id) on delete restrict,
 unique(document_id,revision)
);
create table public.studio_events_v2 (
 id bigint generated always as identity primary key,organization_id uuid not null,document_id uuid not null,
 revision integer not null,action text not null,actor_id uuid not null references public.profiles(id) on delete restrict,
 comment text,command_id uuid not null,request_hash text not null,created_at timestamptz not null default now(),
 foreign key(organization_id,document_id) references public.studio_documents_v2(organization_id,id) on delete restrict,
 unique(organization_id,command_id)
);
alter table public.studio_documents_v2 enable row level security;
alter table public.studio_versions_v2 enable row level security;
alter table public.studio_events_v2 enable row level security;
revoke all on public.studio_documents_v2,public.studio_versions_v2,public.studio_events_v2 from public,anon,authenticated;
grant select on public.studio_documents_v2,public.studio_versions_v2,public.studio_events_v2 to service_role;
create trigger studio_version_immutable before update or delete on public.studio_versions_v2 for each row execute function public.project_brief_immutable_v2();
create trigger studio_event_immutable before update or delete on public.studio_events_v2 for each row execute function public.project_brief_immutable_v2();

create function public.studio_task_access_v2(p_organization_id uuid,p_task_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and public.current_member_role_key(p_organization_id)<>'client' and exists(
 select 1 from public.work_tasks t join public.records p on p.id=t.project_record_id and p.organization_id=t.organization_id and p.coll='projects' and p.deleted_at is null
 join public.client_accounts c on c.id=t.client_account_id and c.organization_id=t.organization_id and c.legacy_record_id=p.data->>'clientId' and c.deleted_at is null and c.archived_at is null
 where t.id=p_task_id and t.organization_id=p_organization_id and t.deleted_at is null
 and public.can_read_task_v2(t.organization_id,t.legacy_client_id,t.assigned_user_id,t.assigned_employee_record_id,t.client_visible))
$$;
create function public.list_studio_v2(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare tasks jsonb;documents jsonb;
begin
 if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'work.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='studio_access_required';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'projectId',t.project_record_id,'project',p.data->>'name','client',c.display_name,'clientId',c.legacy_record_id) order by t.updated_at desc),'[]') into tasks
 from public.work_tasks t join public.records p on p.id=t.project_record_id join public.client_accounts c on c.id=t.client_account_id
 where t.organization_id=p_organization_id and public.studio_task_access_v2(p_organization_id,t.id);
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'taskId',d.task_id,'kind',d.kind,'revision',d.revision,'status',d.status,'updatedAt',d.updated_at,'title',v.payload->>'title') order by d.updated_at desc),'[]') into documents
 from public.studio_documents_v2 d left join public.studio_versions_v2 v on v.document_id=d.id and v.revision=d.revision
 where d.organization_id=p_organization_id and public.studio_task_access_v2(p_organization_id,d.task_id);
 return jsonb_build_object('ok',true,'tasks',tasks,'documents',documents,'campaigns',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'title',r.data->>'name','clientId',r.data->>'clientId')) from public.records r where r.organization_id=p_organization_id and r.coll='campaigns' and r.deleted_at is null and public.records_can_read(r.organization_id,r.coll,r.data)),'[]'::jsonb));
end;$$;
create function public.get_studio_v2(p_organization_id uuid,p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d public.studio_documents_v2%rowtype;task jsonb;versions jsonb;events jsonb;
begin
 select * into d from public.studio_documents_v2 where organization_id=p_organization_id and id=p_document_id;
 if d.id is null or not public.studio_task_access_v2(p_organization_id,d.task_id) then raise exception using errcode='42501',message='studio_access_required';end if;
 task:=public.get_task_v2(p_organization_id,d.task_id);
 select coalesce(jsonb_agg(jsonb_build_object('revision',v.revision,'payload',v.payload,'fileId',case when exists(select 1 from public.document_files f where f.id=v.file_id and f.deleted_at is null and public.can_read_document_v2(f.organization_id,f.visibility,f.legacy_client_id,f.employee_record_id)) then v.file_id else null end,'createdAt',v.created_at,'createdBy',v.created_by) order by v.revision desc),'[]') into versions from public.studio_versions_v2 v where v.document_id=d.id;
 select coalesce(jsonb_agg(jsonb_build_object('revision',e.revision,'action',e.action,'comment',e.comment,'createdAt',e.created_at) order by e.id desc),'[]') into events from public.studio_events_v2 e where e.document_id=d.id;
 return jsonb_build_object('ok',true,'document',to_jsonb(d),'task',task->'task','comments',task->'comments','files',task->'documents','versions',versions,'events',events,
 'canReview',public.has_org_capability(p_organization_id,'approvals.manage') and exists(select 1 from public.studio_versions_v2 v where v.document_id=d.id and v.revision=d.revision and v.created_by<>auth.uid()));
end;$$;
create function public.studio_command_v2(p_organization_id uuid,p_document_id uuid,p_task_id uuid,p_kind text,p_campaign_id text,p_expected_revision integer,p_action text,p_payload jsonb,p_file_id uuid,p_comment text,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.studio_documents_v2%rowtype;t public.work_tasks%rowtype;e public.studio_events_v2%rowtype;v public.studio_versions_v2%rowtype;h text;next_status text;
begin
 if auth.uid() is null or p_command_id is null or p_document_id is null or p_expected_revision is null or p_expected_revision<0 or not public.studio_task_access_v2(p_organization_id,p_task_id) then raise exception using errcode='42501',message='studio_access_required';end if;
 if p_action not in('SAVE','SUBMIT','REVISION','APPROVE','FINAL') or p_action is null or char_length(coalesce(p_comment,''))>2000 then raise exception 'studio_request_invalid';end if;
 h:=encode(extensions.digest(jsonb_build_array(p_document_id,p_task_id,p_kind,p_campaign_id,p_expected_revision,p_action,p_payload,p_file_id,p_comment)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into e from public.studio_events_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then
  if e.actor_id<>auth.uid() or e.request_hash<>h then raise exception 'studio_idempotency_conflict';end if;
  return public.get_studio_v2(p_organization_id,e.document_id)||jsonb_build_object('replayed',true);
 end if;
 select * into t from public.work_tasks where organization_id=p_organization_id and id=p_task_id for update;
 select * into d from public.studio_documents_v2 where id=p_document_id for update;
 if d.id is null then
  if p_action<>'SAVE' or p_expected_revision<>0 or p_kind not in('brief','report','content','design','video') then raise exception 'studio_create_invalid';end if;
  if p_campaign_id is not null and not exists(select 1 from public.records r where r.id=p_campaign_id and r.coll='campaigns' and r.organization_id=p_organization_id and r.deleted_at is null and r.data->>'clientId'=t.legacy_client_id and public.records_can_read(r.organization_id,r.coll,r.data)) then raise exception 'studio_campaign_invalid';end if;
  if p_kind in('content','design','video') and not exists(select 1 from public.studio_documents_v2 b join public.work_tasks bt on bt.id=b.task_id where b.id=nullif(p_payload->>'briefId','')::uuid and b.organization_id=p_organization_id and b.kind='brief' and b.revision>0 and bt.project_record_id=t.project_record_id and public.studio_task_access_v2(p_organization_id,bt.id)) then raise exception 'studio_brief_required';end if;
  insert into public.studio_documents_v2(id,organization_id,task_id,kind,campaign_record_id,brief_document_id,created_by) values(p_document_id,p_organization_id,p_task_id,p_kind,p_campaign_id,case when p_kind in('content','design','video') then nullif(p_payload->>'briefId','')::uuid else null end,auth.uid()) returning * into d;
 end if;
 if d.organization_id<>p_organization_id or d.task_id<>p_task_id then raise exception using errcode='42501',message='studio_access_required';end if;
 if d.kind is distinct from p_kind or d.campaign_record_id is distinct from p_campaign_id then raise exception 'studio_context_locked';end if;
 if d.revision<>p_expected_revision then raise exception using errcode='PT409',message='studio_revision_conflict';end if;
 select * into v from public.studio_versions_v2 where document_id=d.id and revision=d.revision;
 next_status:=d.status;
 if p_action='SAVE' then
  if d.status not in('DRAFT','REVISION') then raise exception 'studio_revision_locked';end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or char_length(btrim(coalesce(p_payload->>'title','')))<2 or char_length(p_payload->>'title')>240 or octet_length(p_payload::text)>262144 then raise exception 'studio_document_invalid';end if;
  if d.brief_document_id is not null and d.brief_document_id::text is distinct from p_payload->>'briefId' then raise exception 'studio_brief_locked';end if;
  if p_file_id is not null and not exists(select 1 from public.task_document_links_v2 l join public.document_files f on f.id=l.document_id where l.organization_id=p_organization_id and l.task_id=t.id and f.id=p_file_id and f.status='ACTIVE' and f.deleted_at is null and public.can_read_document_v2(f.organization_id,f.visibility,f.legacy_client_id,f.employee_record_id)) then raise exception 'studio_file_invalid';end if;
  d.revision:=d.revision+1;
  insert into public.studio_versions_v2(organization_id,document_id,revision,payload,file_id,created_by) values(p_organization_id,d.id,d.revision,p_payload,p_file_id,auth.uid());
  next_status:='DRAFT';
 elsif p_action='SUBMIT' then
  if d.status<>'DRAFT' or v.id is null then raise exception 'studio_not_ready';end if;
  next_status:='INTERNAL_REVIEW';
 elsif p_action in('APPROVE','REVISION') then
  if not public.has_org_capability(p_organization_id,'approvals.manage') or v.created_by=auth.uid() then raise exception using errcode='42501',message='studio_independent_reviewer_required';end if;
  if d.status<>'INTERNAL_REVIEW' or (p_action='REVISION' and nullif(btrim(p_comment),'') is null) then raise exception 'studio_review_invalid';end if;
  next_status:=case p_action when 'APPROVE' then 'APPROVED' else 'REVISION' end;
 elsif p_action='FINAL' then
  if d.status<>'APPROVED' then raise exception 'studio_approval_required';end if;
  next_status:='FINAL';
 end if;
 update public.studio_documents_v2 set revision=d.revision,status=next_status,updated_at=now() where id=d.id;
 insert into public.studio_events_v2(organization_id,document_id,revision,action,actor_id,comment,command_id,request_hash) values(p_organization_id,d.id,d.revision,p_action,auth.uid(),nullif(btrim(p_comment),''),p_command_id,h);
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'STUDIO_'||p_action,'studio',d.id::text,jsonb_build_object('revision',d.revision,'taskId',t.id));
 if p_action<>'SAVE' then
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
  select p_organization_id,m.user_id,'TASK_STATUS','INFO','Studio review updated',p_action,'studio','studio',d.id::text,'studio:'||p_command_id::text||':'||m.user_id::text
  from public.organization_members m where m.organization_id=p_organization_id and m.status='ACTIVE' and m.user_id<>auth.uid() and m.user_id in(t.assigned_user_id,t.created_by_user_id) on conflict do nothing;
 end if;
 return public.get_studio_v2(p_organization_id,d.id);
end;$$;
create function public.guard_studio_task_context_v2() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.organization_id,new.task_id) is distinct from (old.organization_id,old.task_id) then raise exception 'studio_context_locked';end if;return new;
end;$$;
create trigger studio_context_immutable before update on public.studio_documents_v2 for each row execute function public.guard_studio_task_context_v2();
create function public.guard_studio_task_relationship_v2() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.organization_id,new.project_record_id,new.client_account_id,new.legacy_client_id) is distinct from (old.organization_id,old.project_record_id,old.client_account_id,old.legacy_client_id) and exists(select 1 from public.studio_documents_v2 d where d.task_id=old.id) then raise exception 'studio_task_relationship_locked';end if;return new;
end;$$;
create trigger studio_task_relationship_immutable before update on public.work_tasks for each row execute function public.guard_studio_task_relationship_v2();
revoke all on function public.guard_studio_task_context_v2(),public.guard_studio_task_relationship_v2() from public,anon,authenticated;
revoke all on function public.studio_task_access_v2(uuid,uuid),public.list_studio_v2(uuid),public.get_studio_v2(uuid,uuid),public.studio_command_v2(uuid,uuid,uuid,text,text,integer,text,jsonb,uuid,text,uuid) from public,anon;
grant execute on function public.studio_task_access_v2(uuid,uuid),public.list_studio_v2(uuid),public.get_studio_v2(uuid,uuid),public.studio_command_v2(uuid,uuid,uuid,text,text,integer,text,jsonb,uuid,text,uuid) to authenticated;
commit;
