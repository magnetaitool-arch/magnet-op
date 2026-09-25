-- Add immutable operational briefs to existing projects. No business rows rewritten.
-- Existing unlinked/ambiguous briefs remain unlinked until explicitly reviewed.
begin;
create table public.project_brief_revisions_v2 (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 project_record_id text not null references public.records(id) on delete restrict,
 brief_record_id text not null references public.records(id) on delete restrict,
 client_account_id uuid not null,
 revision integer not null check(revision>0),
 source_hash text not null,
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 captured_by uuid not null references public.profiles(id) on delete restrict,
 captured_at timestamptz not null default now(),
 command_id uuid not null,
 expected_revision integer not null,
 foreign key(organization_id,client_account_id) references public.client_accounts(organization_id,id) on delete restrict,
 unique(organization_id,project_record_id,revision),unique(organization_id,command_id)
);
alter table public.project_brief_revisions_v2 enable row level security;
revoke all on public.project_brief_revisions_v2 from public,anon,authenticated;
grant select,insert on public.project_brief_revisions_v2 to service_role;
create or replace function public.brief_execution_snapshot_v2(p_data jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('company',p_data->>'company','projectType',p_data->>'projectType','submittedAt',p_data->>'submittedAt','answers',coalesce((
  select jsonb_object_agg(key,value) from jsonb_each(case when jsonb_typeof(p_data->'answers')='object' then p_data->'answers' else '{}'::jsonb end)
  where key=any(array['company','industry','aboutBiz','wants','objective','audience','geo','lang','competitors','differentiation','brandAssets','tone','references','donts','budget','timeline','urgency','notes'])
 ),'{}'::jsonb))
$$;
create or replace function public.project_brief_immutable_v2()
returns trigger language plpgsql set search_path='' as $$begin raise exception 'project_brief_history_immutable';end;$$;
create trigger project_brief_history_immutable before update or delete on public.project_brief_revisions_v2 for each row execute function public.project_brief_immutable_v2();
-- The records table remains the project source of truth. Enrollment pins its tenant,
-- collection and client to the historical relationship; soft deletion retains history.
create or replace function public.guard_project_brief_relationship_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.id is distinct from old.id or new.organization_id is distinct from old.organization_id or new.coll is distinct from old.coll or new.data->>'clientId' is distinct from old.data->>'clientId') and exists(select 1 from public.project_brief_revisions_v2 r where r.project_record_id=old.id or r.brief_record_id=old.id) then
  raise exception 'project_brief_relationship_locked';
 end if;
 return new;
end;$$;
create trigger project_brief_relationship_guard before update on public.records for each row execute function public.guard_project_brief_relationship_v2();
create or replace function public.get_project_briefs_v2(p_organization_id uuid,p_project_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.records%rowtype;c public.client_accounts%rowtype;items jsonb;versions jsonb;current_revision integer;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'work.read') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='project_brief_read_required';end if;
 select * into p from public.records where organization_id=p_organization_id and id=p_project_id and coll='projects' and deleted_at is null;
 if p.id is null then raise exception 'project_unavailable';end if;
 select * into c from public.client_accounts where organization_id=p_organization_id and legacy_record_id=p.data->>'clientId' and deleted_at is null and archived_at is null;
 if c.id is null then raise exception 'project_client_review_required';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'title',coalesce(nullif(b.data->>'company',''),nullif(b.data->>'projectType',''),b.id),'submittedAt',b.data->>'submittedAt','sourceHash',encode(extensions.digest(public.brief_execution_snapshot_v2(b.data)::text,'sha256'),'hex')) order by b.data->>'submittedAt' desc,b.id),'[]'::jsonb) into items
 from public.records b where b.organization_id=p_organization_id and b.coll='briefs' and b.deleted_at is null and b.data->>'clientId'=c.legacy_record_id and b.data->>'status'='submitted' and jsonb_typeof(b.data->'answers')='object' and b.data->'answers'<>'{}'::jsonb;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,'briefId',r.brief_record_id,'snapshot',r.snapshot,'capturedAt',r.captured_at,'capturedBy',r.captured_by,'sourceChanged',not exists(select 1 from public.records b where b.id=r.brief_record_id and b.organization_id=r.organization_id and b.coll='briefs' and b.deleted_at is null and b.data->>'status'='submitted' and encode(extensions.digest(public.brief_execution_snapshot_v2(b.data)::text,'sha256'),'hex')=r.source_hash)) order by r.revision desc),'[]'::jsonb),coalesce(max(r.revision),0) into versions,current_revision
 from public.project_brief_revisions_v2 r where r.organization_id=p_organization_id and r.project_record_id=p_project_id and r.client_account_id=c.id;
 return jsonb_build_object('ok',true,'projectId',p_project_id,'revision',current_revision,'canManage',public.has_org_capability(p_organization_id,'work.manage'),'sources',items,'revisions',versions);
end;$$;
create or replace function public.capture_project_brief_v2(p_organization_id uuid,p_project_id text,p_brief_id text,p_source_hash text,p_expected_revision integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.records%rowtype;b public.records%rowtype;c public.client_accounts%rowtype;r public.project_brief_revisions_v2%rowtype;snapshot jsonb;hash text;version integer;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'work.manage') or not public.has_org_capability(p_organization_id,'work.read') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='project_brief_manage_required';end if;
 if p_command_id is null or p_expected_revision is null or p_expected_revision<0 or p_source_hash is null then raise exception 'project_brief_request_invalid';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into p from public.records where organization_id=p_organization_id and id=p_project_id and coll='projects' and deleted_at is null for update;
 if p.id is null then raise exception 'project_unavailable';end if;
 select * into r from public.project_brief_revisions_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then
  if r.project_record_id<>p_project_id or r.brief_record_id<>p_brief_id or r.source_hash<>p_source_hash or r.expected_revision<>p_expected_revision or r.captured_by<>auth.uid() then raise exception 'idempotency_conflict';end if;
  return public.get_project_briefs_v2(p_organization_id,p_project_id)||jsonb_build_object('replayed',true);
 end if;
 select coalesce(max(revision),0) into version from public.project_brief_revisions_v2 where organization_id=p_organization_id and project_record_id=p_project_id;
 if version<>p_expected_revision then raise exception using errcode='40001',message='project_brief_version_conflict';end if;
 select * into c from public.client_accounts where organization_id=p_organization_id and legacy_record_id=p.data->>'clientId' and deleted_at is null and archived_at is null;
 if c.id is null then raise exception 'project_client_review_required';end if;
 select * into b from public.records where organization_id=p_organization_id and id=p_brief_id and coll='briefs' and deleted_at is null for update;
 if b.id is null or b.data->>'clientId' is distinct from c.legacy_record_id then raise exception 'project_brief_client_mismatch';end if;
 if b.data->>'status' is distinct from 'submitted' or jsonb_typeof(b.data->'answers') is distinct from 'object' then raise exception 'project_brief_submission_required';end if;
 snapshot=public.brief_execution_snapshot_v2(b.data);hash=encode(extensions.digest(snapshot::text,'sha256'),'hex');
 if snapshot->'answers'='{}'::jsonb then raise exception 'project_brief_answers_required';end if;
 if hash<>p_source_hash then raise exception using errcode='40001',message='project_brief_source_changed';end if;
 if exists(select 1 from public.project_brief_revisions_v2 where organization_id=p_organization_id and project_record_id=p_project_id and revision=version and brief_record_id=p_brief_id and source_hash=hash) then raise exception 'project_brief_already_current';end if;
 insert into public.project_brief_revisions_v2(organization_id,project_record_id,brief_record_id,client_account_id,revision,source_hash,snapshot,captured_by,command_id,expected_revision)
 values(p_organization_id,p_project_id,p_brief_id,c.id,version+1,hash,snapshot,auth.uid(),p_command_id,p_expected_revision);
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'PROJECT_BRIEF_CAPTURED','project',p_project_id,jsonb_build_object('briefId',p_brief_id,'revision',version+1));
 return public.get_project_briefs_v2(p_organization_id,p_project_id);
end;$$;
revoke all on function public.brief_execution_snapshot_v2(jsonb),public.project_brief_immutable_v2(),public.guard_project_brief_relationship_v2() from public,anon,authenticated;
revoke all on function public.get_project_briefs_v2(uuid,text),public.capture_project_brief_v2(uuid,text,text,text,integer,uuid) from public,anon;
grant execute on function public.get_project_briefs_v2(uuid,text),public.capture_project_brief_v2(uuid,text,text,text,integer,uuid) to authenticated;
commit;
-- Roll back application entry point only. Preserve snapshots, audit and source records.
