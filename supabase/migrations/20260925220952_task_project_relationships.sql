-- Preserve legacy tasks; add a verified relational reference only where evidence matches.
begin;
alter table public.records add constraint records_organization_id_id_unique unique(organization_id,id);
alter table public.work_tasks add column project_reference_id text;
alter table public.work_tasks add constraint work_tasks_project_reference_fk foreign key(organization_id,project_reference_id) references public.records(organization_id,id) on delete restrict;
create index work_tasks_project_reference_idx on public.work_tasks(organization_id,project_reference_id);
update public.work_tasks t set project_reference_id=p.id
from public.records p,public.client_accounts c
where p.id=t.project_record_id and p.organization_id=t.organization_id and p.coll='projects'
 and c.id=t.client_account_id and c.organization_id=t.organization_id and c.legacy_record_id=t.legacy_client_id and p.data->>'clientId'=c.legacy_record_id;
insert into public.task_projection_issues_v2(organization_id,legacy_record_id,issue_code)
select organization_id,legacy_record_id,'PROJECT_RELATIONSHIP_REVIEW_REQUIRED' from public.work_tasks where project_reference_id is null
on conflict(organization_id,legacy_record_id,issue_code) do update set resolved_at=null,last_seen_at=now();
create or replace function public.enforce_task_project_reference_v2()
returns trigger language plpgsql security definer set search_path='' as $$
declare prior public.work_tasks%rowtype;p public.records%rowtype;c public.client_accounts%rowtype;valid boolean;active boolean;changed boolean;
begin
 select * into p from public.records where organization_id=new.organization_id and id=new.project_record_id and coll='projects' for share;
 select * into c from public.client_accounts where organization_id=new.organization_id and id=new.client_account_id;
 valid=p.id is not null and c.id is not null and c.legacy_record_id is not distinct from new.legacy_client_id and p.data->>'clientId' is not distinct from c.legacy_record_id;
 active=valid and p.deleted_at is null and c.deleted_at is null and c.archived_at is null;
 if tg_op='UPDATE' then prior=old;else select * into prior from public.work_tasks where organization_id=new.organization_id and legacy_record_id=new.legacy_record_id;end if;
 changed=prior.id is null;
 if prior.id is not null then changed=new.organization_id is distinct from prior.organization_id or new.project_record_id is distinct from prior.project_record_id or new.client_account_id is distinct from prior.client_account_id or new.legacy_client_id is distinct from prior.legacy_client_id or (new.status is distinct from prior.status and new.status not in('Blocked','Cancelled'));end if;
 if auth.role()='authenticated' and changed and not active then raise exception using errcode='23503',message='task_project_relationship_review_required';end if;
 new.project_reference_id=case when valid then p.id else null end;
 if not valid then
  insert into public.task_projection_issues_v2(organization_id,legacy_record_id,issue_code) values(new.organization_id,new.legacy_record_id,'PROJECT_RELATIONSHIP_REVIEW_REQUIRED') on conflict(organization_id,legacy_record_id,issue_code) do update set resolved_at=null,last_seen_at=now();
 else update public.task_projection_issues_v2 set resolved_at=now() where organization_id=new.organization_id and legacy_record_id=new.legacy_record_id and issue_code='PROJECT_RELATIONSHIP_REVIEW_REQUIRED' and resolved_at is null;end if;
 return new;
end;$$;
create trigger enforce_task_project_reference before insert or update on public.work_tasks for each row execute function public.enforce_task_project_reference_v2();
create or replace function public.guard_project_task_identity_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.coll='projects' and (new.coll is distinct from old.coll or new.organization_id is distinct from old.organization_id or new.id is distinct from old.id or new.data->>'clientId' is distinct from old.data->>'clientId') and exists(select 1 from public.work_tasks where organization_id=old.organization_id and project_reference_id=old.id) then raise exception 'project_task_relationship_locked';end if;
 -- Projection identity cannot be orphaned by converting a task to a different collection.
 if old.coll='tasks' and (new.coll is distinct from old.coll or new.organization_id is distinct from old.organization_id or new.id is distinct from old.id) and exists(select 1 from public.work_tasks where organization_id=old.organization_id and legacy_record_id=old.id) then raise exception 'task_projection_identity_locked';end if;
 return new;
end;$$;
create trigger guard_project_task_identity before update on public.records for each row execute function public.guard_project_task_identity_v2();
revoke all on function public.enforce_task_project_reference_v2(),public.guard_project_task_identity_v2() from public,anon,authenticated;
commit;
-- Rollback: disable application writes first. Retain nullable references/issues; no source rows removed.
