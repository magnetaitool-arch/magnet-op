-- Additive owner review and backup evidence. No decisions or business repairs during migration.
begin;
create table public.legacy_review_cases_v3(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete restrict,
 case_key text not null,case_type text not null,group_key text not null,title text not null,description text not null,context text not null,
 record_ids text[] not null default '{}',metadata jsonb not null default '{}',source_hash text not null,
 risk_level text not null check(risk_level in('LOW','MEDIUM','HIGH')),
 status text not null default 'OPEN' check(status in('OPEN','NEEDS_REVIEW','DECIDED','READY_TO_EXECUTE','RESOLVED','IGNORED','NEEDS_MORE_INFO','FAILED')),
 version integer not null default 1,decision text,decision_args jsonb not null default '{}',owner_notes text,
 reviewed_by uuid references public.profiles(id),reviewed_at timestamptz,executed_at timestamptz,
 execution_status text not null default 'NOT_EXECUTED',reconciliation_status text not null default 'NOT_RUN',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(organization_id,case_key),unique(organization_id,id)
);
create table public.legacy_review_events_v3(
 id bigint generated always as identity primary key,organization_id uuid not null,case_id uuid not null,
 actor_id uuid references public.profiles(id),action text not null,decision text,notes text,
 command_id uuid not null,request_hash text not null,result jsonb not null,created_at timestamptz not null default now(),
 foreign key(organization_id,case_id) references public.legacy_review_cases_v3(organization_id,id) on delete restrict,
 unique(organization_id,command_id)
);
create table public.legacy_review_previews_v3(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,case_id uuid not null,
 actor_id uuid not null references public.profiles(id),version integer not null,decision text not null,args jsonb not null,
 fingerprint text not null,impact jsonb not null,created_at timestamptz not null default now(),
 foreign key(organization_id,case_id) references public.legacy_review_cases_v3(organization_id,id) on delete restrict
);
create table public.legacy_contact_links_v3(
 organization_id uuid not null,record_id text not null,canonical_record_id text not null,case_id uuid not null,
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 primary key(organization_id,record_id),
 foreign key(organization_id,record_id) references public.records(organization_id,id) on delete restrict,
 foreign key(organization_id,canonical_record_id) references public.records(organization_id,id) on delete restrict,
 foreign key(organization_id,case_id) references public.legacy_review_cases_v3(organization_id,id) on delete restrict
);
create table public.backup_evidence_v3(
 id uuid primary key,organization_id uuid not null references public.organizations(id),
 state text not null check(state in('STARTED','FAILED','EXPORTED','RESTORED')),
 archive_ref text,checksum text,storage_objects integer,retention_days integer,
 off_device boolean not null default false,schedule_active boolean not null default false,next_run_at timestamptz,
 restore_passed boolean not null default false,diagnostic_code text,
 created_at timestamptz not null default now()
);
create index legacy_review_filter_v3 on public.legacy_review_cases_v3(organization_id,status,case_type);
create trigger legacy_review_event_immutable before update or delete on public.legacy_review_events_v3 for each row execute function public.project_brief_immutable_v2();
create trigger backup_evidence_immutable before update or delete on public.backup_evidence_v3 for each row execute function public.project_brief_immutable_v2();
alter table public.legacy_review_cases_v3 enable row level security;
alter table public.legacy_review_events_v3 enable row level security;
alter table public.legacy_review_previews_v3 enable row level security;
alter table public.legacy_contact_links_v3 enable row level security;
alter table public.backup_evidence_v3 enable row level security;
revoke all on public.legacy_review_cases_v3,public.legacy_review_events_v3,public.legacy_review_previews_v3,public.legacy_contact_links_v3,public.backup_evidence_v3 from public,anon,authenticated;
grant select on public.legacy_review_cases_v3,public.legacy_review_events_v3,public.legacy_contact_links_v3,public.backup_evidence_v3 to service_role;
create function public.legacy_review_access_v3(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and public.is_active_org_member(p_org) and public.current_member_role_key(p_org) in('owner','admin') and public.has_org_capability(p_org,'organization.manage')
$$;
create function public.import_legacy_review_v3(p_org uuid,p_cases jsonb,p_source_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare x jsonb;ids text[];n integer:=0;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server_import_required';end if;
 if jsonb_typeof(p_cases)<>'array' or jsonb_array_length(p_cases)>2000 or p_source_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_source';end if;
 for x in select * from jsonb_array_elements(p_cases) loop
  select coalesce(array_agg(v),'{}') into ids from jsonb_array_elements_text(x->'record_ids') v;
  if exists(select 1 from public.records where id=any(ids) and organization_id is distinct from p_org) then raise exception 'case_reference_tenant_mismatch';end if;
  if x->>'case_key' !~ '^[A-Z]+-[0-9]{3}$' then raise exception 'invalid_case_key';end if;
  insert into public.legacy_review_cases_v3(organization_id,case_key,case_type,group_key,title,description,context,record_ids,metadata,source_hash,risk_level)
  values(p_org,x->>'case_key',x->>'case_type',x->>'group_key',x->>'title',x->>'description',x->>'context',ids,x->'metadata',p_source_hash,x->>'risk_level') on conflict(organization_id,case_key) do nothing;
  n:=n+1;
 end loop;
 return jsonb_build_object('ok',true,'sourceCases',n,'cases',(select count(*) from public.legacy_review_cases_v3 where organization_id=p_org),'groups',(select count(distinct group_key) from public.legacy_review_cases_v3 where organization_id=p_org));
end;$$;
create function public.legacy_review_fingerprint_v3(p_case uuid,p_args jsonb) returns text language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_object('caseRefs',c.record_ids,'records',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.records r where r.organization_id=c.organization_id and (r.id=any(c.record_ids) or r.id=p_args->>'targetId')),'[]'),
 'links',coalesce((select jsonb_agg(to_jsonb(l) order by l.record_id) from public.legacy_contact_links_v3 l where l.organization_id=c.organization_id and l.record_id=any(c.record_ids)),'[]'),
 'identity',case when c.case_type='IDENTITY' then (select jsonb_agg(to_jsonb(l)) from public.legacy_identity_links l where l.legacy_account_row_id=any(c.record_ids)) else null end,
 'storage',case when c.case_type='STORAGE' then (select jsonb_agg(to_jsonb(o)) from storage.objects o where o.id::text=c.metadata->>'objectId') else null end,
 'roles',case when c.case_type='ROLE' then (select jsonb_agg(to_jsonb(rc) order by rc.role_id,rc.capability_id) from public.role_capabilities rc join public.organization_roles r on r.id=rc.role_id where r.organization_id=c.organization_id) else null end)::text)
 from public.legacy_review_cases_v3 c where c.id=p_case
$$;
create function public.legacy_review_options_v3(p_type text,p_metadata jsonb) returns jsonb language sql immutable as $$
 select to_jsonb(array['LEAVE_UNCHANGED','IGNORE_INTENTIONAL','NEEDS_MORE_INFO']||case when p_type='CONTACT' then array['LINK_CONTACTS'] when p_type='ASSET' and p_metadata->>'field' in('clientId','projectId') then array['RESTORE_PARENT'] when p_type='TASK' then array['LINK_PROJECT'] else array[]::text[] end)
$$;
create function public.list_legacy_review_v3(p_org uuid,p_search text default '',p_type text default '',p_risk text default '',p_status text default '',p_client text default '',p_entity text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb;
begin
 if not public.legacy_review_access_v3(p_org) then raise exception using errcode='42501',message='owner_admin_required';end if;
 select coalesce(jsonb_agg(to_jsonb(c)-'source_hash'-'metadata'-'decision_args' order by c.case_key),'[]') into items from public.legacy_review_cases_v3 c where c.organization_id=p_org
 and(p_type='' or c.case_type=p_type) and(p_risk='' or c.risk_level=p_risk) and(p_status='' or c.status=p_status) and(p_entity='' or p_entity=any(c.record_ids))
 and(p_client='' or exists(select 1 from public.records r where r.id=any(c.record_ids) and r.organization_id=p_org and (r.id=p_client or r.data->>'clientId'=p_client)))
 and(p_search='' or c.case_key ilike '%'||left(p_search,150)||'%' or c.title ilike '%'||left(p_search,150)||'%' or exists(select 1 from public.records r where r.id=any(c.record_ids) and r.organization_id=p_org and (r.id ilike '%'||left(p_search,150)||'%' or concat_ws(' ',r.data->>'name',r.data->>'fullName',r.data->>'email',r.data->>'phone',r.data->>'clientId',r.data->>'projectId') ilike '%'||left(p_search,150)||'%')));
 return jsonb_build_object('ok',true,'items',items,'total',(select count(*) from public.legacy_review_cases_v3 where organization_id=p_org),'groups',(select count(distinct group_key) from public.legacy_review_cases_v3 where organization_id=p_org),
 'summary',(select jsonb_object_agg(status,n) from(select status,count(*) n from public.legacy_review_cases_v3 where organization_id=p_org group by status)s),
 'highRisk',(select count(*) from public.legacy_review_cases_v3 where organization_id=p_org and risk_level='HIGH'),
 'types',(select jsonb_agg(t) from(select distinct case_type t from public.legacy_review_cases_v3 where organization_id=p_org order by 1)s),
 'clients',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',coalesce(r.data->>'name',r.id))),'[]') from public.records r where r.organization_id=p_org and r.coll='clients'));
end;$$;
create function public.get_legacy_review_v3(p_org uuid,p_case uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.legacy_review_cases_v3%rowtype;records jsonb;
begin
 if not public.legacy_review_access_v3(p_org) then raise exception using errcode='42501',message='owner_admin_required';end if;
 select * into c from public.legacy_review_cases_v3 where id=p_case and organization_id=p_org;if not found then raise exception 'case_missing';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'type',r.coll,'name',case when r.coll='_accounts' then 'Private account reference' else coalesce(r.data->>'name',r.data->>'fullName',r.data->>'title',r.id) end,'archived',r.deleted_at is not null or r.data->>'_del'='true',
 'email',case when r.coll in('contacts','leads') and r.data->>'email' is not null then left(r.data->>'email',1)||'***@'||split_part(r.data->>'email','@',2) else null end,
 'phone',case when r.coll in('contacts','leads') and r.data->>'phone' is not null then '***'||right(r.data->>'phone',3) else null end,
 'clientId',r.data->>'clientId','projectId',r.data->>'projectId','assignedTo',r.data->>'assignedTo','invoiceId',r.data->>'invoiceId','status',r.data->>'status','updatedAt',r.updated_at) order by r.id),'[]') into records from public.records r where r.organization_id=p_org and r.id=any(c.record_ids);
 return jsonb_build_object('ok',true,'case',to_jsonb(c)-'source_hash','records',records,'options',public.legacy_review_options_v3(c.case_type,c.metadata),
 'relatedCases',(select coalesce(jsonb_agg(jsonb_build_object('key',case_key,'status',status)),'[]') from public.legacy_review_cases_v3 where organization_id=p_org and group_key=c.group_key),
 'events',(select coalesce(jsonb_agg(jsonb_build_object('action',action,'decision',decision,'actor',actor_id,'at',created_at,'notes',notes,'result',result) order by id desc),'[]') from public.legacy_review_events_v3 where organization_id=p_org and case_id=p_case),
 'targets',case when c.case_type='TASK' then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',coalesce(data->>'name',id),'clientId',data->>'clientId')),'[]') from public.records where organization_id=p_org and coll='projects' and deleted_at is null and coalesce(data->>'_del','false')<>'true') else '[]'::jsonb end);
end;$$;
create function public.legacy_review_command_v3(p_org uuid,p_case uuid,p_expected integer,p_mode text,p_decision text,p_args jsonb,p_notes text,p_command uuid,p_preview uuid default null,p_confirm text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.legacy_review_cases_v3%rowtype;e public.legacy_review_events_v3%rowtype;v public.legacy_review_previews_v3%rowtype;r public.records%rowtype;target public.records%rowtype;
 h text;outcome jsonb;impact jsonb;fp text;ids text[];before_count bigint;after_count bigint;repaired integer:=0;failed boolean:=false;diagnostic text;
begin
 if not public.legacy_review_access_v3(p_org) then raise exception using errcode='42501',message='owner_admin_required';end if;
 if p_command is null or p_expected is null or p_mode not in('SAVE','PREVIEW','EXECUTE') or p_mode is null or jsonb_typeof(p_args) is distinct from 'object' or octet_length(p_args::text)>2048 or char_length(coalesce(p_notes,''))>2000 then raise exception 'invalid_review_request';end if;
 perform pg_advisory_xact_lock(hashtextextended('review:'||p_org::text,0));
 h:=md5(jsonb_build_array(p_case,p_expected,p_mode,p_decision,p_args,p_notes,p_preview,p_confirm)::text);
 select * into e from public.legacy_review_events_v3 where organization_id=p_org and command_id=p_command;
 if found then if e.actor_id<>auth.uid() or e.request_hash<>h then raise exception 'review_idempotency_conflict';end if;return e.result||jsonb_build_object('replayed',true);end if;
 select * into c from public.legacy_review_cases_v3 where organization_id=p_org and id=p_case for update;
 if not found then raise exception 'case_missing';end if;
 if c.version<>p_expected then raise exception using errcode='PT409',message='review_version_conflict';end if;
 if c.status in('RESOLVED','IGNORED') then raise exception 'case_already_closed';end if;
 if not(public.legacy_review_options_v3(c.case_type,c.metadata)?p_decision) or p_decision is null then raise exception 'unsupported_case_action';end if;
 ids:=c.record_ids;
 perform 1 from public.records where organization_id=p_org and (id=any(ids) or id=p_args->>'targetId') order by id for update;
 fp:=public.legacy_review_fingerprint_v3(p_case,p_args);
 if p_mode='SAVE' then
  update public.legacy_review_cases_v3 set decision=p_decision,decision_args=p_args,owner_notes=p_notes,reviewed_by=auth.uid(),reviewed_at=now(),status=case when p_decision='NEEDS_MORE_INFO' then 'NEEDS_MORE_INFO' else 'DECIDED' end,version=version+1,updated_at=now() where id=p_case;
  outcome:=jsonb_build_object('ok',true,'saved',true,'version',c.version+1);
 elsif p_mode='PREVIEW' then
  impact:=jsonb_build_object('action',p_decision,'records',ids,'businessRowsDeleted',0,'businessRowsMoved',0,'confirmation',c.case_key,'warning','No automatic resolution of related cases. Current records will be checked again at execution.');
  if p_decision='LINK_CONTACTS' then
   if not(p_args->>'targetId'=any(ids)) or p_args->>'targetId' is null or cardinality(ids)<2 or exists(select 1 from unnest(ids) x left join public.records rr on rr.id=x and rr.organization_id=p_org where rr.id is null or rr.coll not in('leads','contacts') or rr.deleted_at is not null or coalesce(rr.data->>'_del','false')='true') then raise exception 'contact_scope_requires_review';end if;
   if exists(select 1 from public.legacy_contact_links_v3 where organization_id=p_org and record_id=any(ids) and canonical_record_id<>p_args->>'targetId') then raise exception 'contact_identity_link_conflict';end if;
   impact:=impact||jsonb_build_object('canonicalReference',p_args->>'targetId','identityReferencesLinked',cardinality(ids),'preserved','All original records, activities, opportunities, identifiers and history; no merge or field overwrite.');
  elsif p_decision='RESTORE_PARENT' then
   select * into target from public.records where id=c.metadata->>'parent' and organization_id=p_org;
   select * into r from public.records where id=c.metadata->>'child' and organization_id=p_org;
   if target.id is null or r.id is null or target.coll<>(case c.metadata->>'field' when 'clientId' then 'clients' else 'projects' end) or r.data->>(c.metadata->>'field') is distinct from target.id or (target.deleted_at is null and coalesce(target.data->>'_del','false')<>'true') then raise exception 'parent_relationship_requires_review';end if;
   impact:=impact||jsonb_build_object('restoreRecord',target.id,'reactivateArchivedRecord',true,'affectedChildren',(select count(*) from public.records where organization_id=p_org and data->>(c.metadata->>'field')=target.id),'preserved','Child records and all history; other broken relationships are not changed.');
  elsif p_decision='LINK_PROJECT' then
   select * into r from public.records where id=ids[1] and organization_id=p_org and coll='tasks';
   select * into target from public.records where id=p_args->>'targetId' and organization_id=p_org and coll='projects' and deleted_at is null and coalesce(data->>'_del','false')<>'true';
   if r.id is null or target.id is null or not exists(select 1 from public.client_accounts where organization_id=p_org and legacy_record_id=target.data->>'clientId' and deleted_at is null and archived_at is null) then raise exception 'task_project_requires_review';end if;
   if exists(select 1 from public.work_tasks where organization_id=p_org and legacy_record_id=r.id and project_reference_id is not null) then raise exception 'task_already_has_verified_project';end if;
   impact:=impact||jsonb_build_object('task',r.id,'oldProject',r.data->>'projectId','newProject',target.id,'oldClient',r.data->>'clientId','newClient',target.data->>'clientId','preserved','Task status, assignee, comments, dependencies and archived state.');
  else
   impact:=impact||jsonb_build_object('preserved','All business data stays unchanged. Intentional/unchanged decisions close as IGNORED, not repaired; more-information decisions remain open.');
  end if;
  insert into public.legacy_review_previews_v3(organization_id,case_id,actor_id,version,decision,args,fingerprint,impact) values(p_org,p_case,auth.uid(),c.version,p_decision,p_args,fp,impact) returning * into v;
  outcome:=jsonb_build_object('ok',true,'previewId',v.id,'impact',impact,'expiresAt',v.created_at+interval '15 minutes','version',c.version);
 else
  select * into v from public.legacy_review_previews_v3 where id=p_preview and organization_id=p_org and case_id=p_case and actor_id=auth.uid();
  if v.id is null or v.version<>c.version or v.decision<>p_decision or v.args<>p_args or v.created_at<now()-interval '15 minutes' or p_confirm is distinct from c.case_key then raise exception 'matching_preview_and_confirmation_required';end if;
  if fp is distinct from v.fingerprint then
   update public.legacy_review_cases_v3 set status='NEEDS_REVIEW',execution_status='STALE',reconciliation_status='NOT_RUN',version=version+1,updated_at=now() where id=p_case;
   outcome:=jsonb_build_object('ok',false,'stale',true,'code','records_changed','version',c.version+1);
  else
   select count(*) into before_count from public.records where organization_id=p_org;
   begin
    if p_decision='LINK_CONTACTS' then
     insert into public.legacy_contact_links_v3(organization_id,record_id,canonical_record_id,case_id,created_by) select p_org,x,p_args->>'targetId',p_case,auth.uid() from unnest(ids) x on conflict(organization_id,record_id) do nothing;
     if (select count(*) from public.legacy_contact_links_v3 where organization_id=p_org and record_id=any(ids) and canonical_record_id=p_args->>'targetId')<>cardinality(ids) then raise exception 'contact_link_reconciliation_failed';end if;
     repaired:=cardinality(ids);
    elsif p_decision='RESTORE_PARENT' then
     update public.records set deleted_at=null,data=data-'_del',updated_at=now() where organization_id=p_org and id=c.metadata->>'parent';
     if not exists(select 1 from public.records child join public.records parent on parent.id=child.data->>(c.metadata->>'field') and parent.organization_id=child.organization_id where child.id=c.metadata->>'child' and child.organization_id=p_org and parent.deleted_at is null and coalesce(parent.data->>'_del','false')<>'true') then raise exception 'parent_reconciliation_failed';end if;
     repaired:=1;
    elsif p_decision='LINK_PROJECT' then
     select * into target from public.records where organization_id=p_org and id=p_args->>'targetId';
     update public.records set data=data||jsonb_build_object('projectId',target.id,'clientId',target.data->>'clientId'),updated_at=now() where organization_id=p_org and id=ids[1] and coll='tasks';
     if not exists(select 1 from public.work_tasks where organization_id=p_org and legacy_record_id=ids[1] and project_reference_id=target.id and legacy_client_id=target.data->>'clientId') then raise exception 'task_projection_reconciliation_failed';end if;
     repaired:=1;
    end if;
    select count(*) into after_count from public.records where organization_id=p_org;
    if before_count<>after_count then raise exception 'record_count_reconciliation_failed';end if;
    set constraints all immediate;
   exception when others then failed:=true;diagnostic:=SQLSTATE;end;
   update public.legacy_review_cases_v3 set decision=p_decision,decision_args=p_args,owner_notes=p_notes,reviewed_by=auth.uid(),reviewed_at=now(),executed_at=now(),
    status=case when failed then 'FAILED' when p_decision='NEEDS_MORE_INFO' then 'NEEDS_MORE_INFO' when repaired=0 then 'IGNORED' else 'RESOLVED' end,
    execution_status=case when failed then 'ROLLED_BACK' else 'COMPLETED' end,reconciliation_status=case when failed then 'FAILED' else 'PASS' end,version=version+1,updated_at=now() where id=p_case;
   outcome:=jsonb_build_object('ok',not failed,'version',c.version+1,'changedReferences',case when failed then 0 else repaired end,'reconciliation',case when failed then 'FAILED' else 'PASS' end,'diagnosticCode',diagnostic,'businessRowsDeleted',0);
  end if;
 end if;
 insert into public.legacy_review_events_v3(organization_id,case_id,actor_id,action,decision,notes,command_id,request_hash,result) values(p_org,p_case,auth.uid(),p_mode,p_decision,p_notes,p_command,h,outcome);
 return outcome;
end;$$;
create function public.record_backup_evidence_v3(p_org uuid,p_id uuid,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u record;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='backup_runner_required';end if;
 if p_evidence->>'state' not in('STARTED','FAILED','EXPORTED','RESTORED') or coalesce(p_evidence->>'diagnosticCode','') !~ '^[a-zA-Z0-9_-]{0,80}$' then raise exception 'invalid_backup_evidence';end if;
 if p_evidence->>'state' in('EXPORTED','RESTORED') and (coalesce(p_evidence->>'checksum','') !~ '^[a-f0-9]{64}$' or coalesce(p_evidence->>'archiveRef','')='') then raise exception 'backup_receipt_required';end if;
 if p_evidence->>'state'='RESTORED' and coalesce((p_evidence->>'restorePassed')::boolean,false) is false then raise exception 'restore_proof_required';end if;
 insert into public.backup_evidence_v3(id,organization_id,state,archive_ref,checksum,storage_objects,retention_days,off_device,schedule_active,next_run_at,restore_passed,diagnostic_code)
 values(p_id,p_org,p_evidence->>'state',left(p_evidence->>'archiveRef',300),p_evidence->>'checksum',(p_evidence->>'storageObjects')::integer,(p_evidence->>'retentionDays')::integer,coalesce((p_evidence->>'offDevice')::boolean,false),coalesce((p_evidence->>'scheduleActive')::boolean,false),(p_evidence->>'nextRunAt')::timestamptz,coalesce((p_evidence->>'restorePassed')::boolean,false),p_evidence->>'diagnosticCode') on conflict(id) do nothing;
 if found and p_evidence->>'state'='FAILED' then
  for u in select m.user_id from public.organization_members m join public.organization_roles r on r.id=m.role_id where m.organization_id=p_org and m.status='ACTIVE' and r.key in('owner','admin') loop
   insert into public.user_notifications_v2(organization_id,recipient_user_id,title,message,route,source_key,severity) values(p_org,u.user_id,'Backup failed / فشل النسخ الاحتياطي','No verified recovery point was recorded. Review Backup Health. / راجع حالة النسخ الاحتياطي.','backupHealth','backup-failure:'||p_id::text,'URGENT');
  end loop;
 end if;
 return jsonb_build_object('ok',true);
end;$$;
create function public.backup_health_v3(p_org uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare latest public.backup_evidence_v3%rowtype;success public.backup_evidence_v3%rowtype;restored public.backup_evidence_v3%rowtype;health_state text;
begin
 if not public.legacy_review_access_v3(p_org) then raise exception using errcode='42501',message='owner_admin_required';end if;
 select * into latest from public.backup_evidence_v3 where organization_id=p_org order by created_at desc limit 1;
 select * into success from public.backup_evidence_v3 where organization_id=p_org and state in('EXPORTED','RESTORED') and off_device order by created_at desc limit 1;
 select * into restored from public.backup_evidence_v3 where organization_id=p_org and state='RESTORED' and restore_passed order by created_at desc limit 1;
 health_state:=case when latest.id is null then 'NOT_CONFIGURED' when latest.state='FAILED' then 'FAILED' when success.id is null or not success.schedule_active or success.created_at<now()-interval '36 hours' or success.next_run_at is null or success.next_run_at<now() or restored.id is null or restored.created_at<now()-interval '30 days' or (latest.state='STARTED' and latest.created_at<now()-interval '30 minutes') then 'WARNING' else 'HEALTHY' end;
 return jsonb_build_object('ok',true,'status',health_state,'database',case when success.id is null then 'NOT_CONFIGURED' else health_state end,'lastSuccessfulBackup',success.created_at,'nextScheduledBackup',case when success.schedule_active then success.next_run_at else null end,'retentionDays',success.retention_days,'storageProtection',case when success.storage_objects is null then 'NOT_CONFIGURED' else health_state end,'storageObjects',success.storage_objects,'lastRestoreTest',restored.created_at,'scheduleActive',coalesce(success.schedule_active,false),'diagnosticCode',latest.diagnostic_code);
end;$$;
revoke all on function public.legacy_review_access_v3(uuid),public.import_legacy_review_v3(uuid,jsonb,text),public.legacy_review_fingerprint_v3(uuid,jsonb),public.legacy_review_options_v3(text,jsonb),public.list_legacy_review_v3(uuid,text,text,text,text,text,text),public.get_legacy_review_v3(uuid,uuid),public.legacy_review_command_v3(uuid,uuid,integer,text,text,jsonb,text,uuid,uuid,text),public.record_backup_evidence_v3(uuid,uuid,jsonb),public.backup_health_v3(uuid) from public,anon,authenticated;
grant execute on function public.legacy_review_access_v3(uuid),public.list_legacy_review_v3(uuid,text,text,text,text,text,text),public.get_legacy_review_v3(uuid,uuid),public.legacy_review_command_v3(uuid,uuid,integer,text,text,jsonb,text,uuid,uuid,text),public.backup_health_v3(uuid) to authenticated;
grant execute on function public.import_legacy_review_v3(uuid,jsonb,text),public.record_backup_evidence_v3(uuid,uuid,jsonb) to service_role;
commit;
