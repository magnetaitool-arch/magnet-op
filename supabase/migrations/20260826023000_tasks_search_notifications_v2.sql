-- MAGNET OS V2 / M10: canonical tasks, accountable completion, actionable
-- per-user notifications, and permission-aware global search.
--
-- This migration is additive. Legacy task/notification records are preserved
-- and projected forward so existing modules keep working during cutover.

begin;

create table if not exists public.work_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null,
  task_code text not null,
  title text not null check (char_length(btrim(title)) between 2 and 240),
  description text,
  client_account_id uuid,
  legacy_client_id text,
  project_record_id text not null,
  deliverable_record_id text,
  assigned_employee_record_id text,
  assigned_user_id uuid references public.profiles(id) on delete restrict,
  created_by_user_id uuid references public.profiles(id) on delete restrict,
  task_type text,
  status text not null check (status in (
    'Backlog','To Do','In Progress','Waiting for Client','Internal Review',
    'Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled'
  )),
  priority text not null check (priority in ('Low','Normal','Medium','High','Urgent')),
  start_date date,
  due_date date,
  completed_at timestamptz,
  completed_by_user_id uuid references public.profiles(id) on delete restrict,
  estimated_hours numeric(10,2) not null default 0 check (estimated_hours>=0),
  actual_hours numeric(10,2) not null default 0 check (actual_hours>=0),
  brief text,
  requirements text,
  reference_links text,
  delivery_link text,
  blockers text,
  client_visible boolean not null default false,
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (organization_id,client_account_id)
    references public.client_accounts(organization_id,id) on delete restrict,
  unique(organization_id,id),
  unique(organization_id,legacy_record_id)
);

create index if not exists work_tasks_org_status_due_idx
  on public.work_tasks(organization_id,status,due_date,updated_at desc) where deleted_at is null;
create index if not exists work_tasks_assignee_idx
  on public.work_tasks(organization_id,assigned_user_id,status,due_date) where deleted_at is null;
create index if not exists work_tasks_employee_idx
  on public.work_tasks(organization_id,assigned_employee_record_id,status,due_date) where deleted_at is null;
create index if not exists work_tasks_search_idx
  on public.work_tasks(organization_id,lower(title),lower(task_code)) where deleted_at is null;

create table if not exists public.task_events_v2 (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  task_id uuid not null,
  action text not null check (action in ('IMPORTED','CREATED','UPDATED','STATUS_CHANGED','COMMENTED','DOCUMENT_LINKED')),
  from_status text,
  to_status text,
  note text,
  actor_user_id uuid references public.profiles(id) on delete set null,
  safe_context jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_context)='object'),
  occurred_at timestamptz not null default now(),
  foreign key (organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict
);
create index if not exists task_events_v2_task_idx on public.task_events_v2(organization_id,task_id,occurred_at desc);

create table if not exists public.task_comments_v2 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  author_user_id uuid not null references public.profiles(id) on delete restrict,
  visibility text not null default 'INTERNAL' check (visibility in ('INTERNAL','CLIENT')),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  foreign key (organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict
);
create index if not exists task_comments_v2_task_idx on public.task_comments_v2(organization_id,task_id,created_at);

create table if not exists public.task_document_links_v2 (
  organization_id uuid not null,
  task_id uuid not null,
  document_id uuid not null,
  linked_by_user_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(organization_id,task_id,document_id),
  foreign key (organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict,
  foreign key (organization_id,document_id) references public.document_files(organization_id,id) on delete restrict
);

create table if not exists public.task_projection_issues_v2 (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null,
  issue_code text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(organization_id,legacy_record_id,issue_code)
);

create table if not exists public.user_notifications_v2 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  recipient_user_id uuid not null references public.profiles(id) on delete restrict,
  notification_type text not null default 'INFO',
  severity text not null default 'INFO' check (severity in ('INFO','SUCCESS','WARNING','URGENT')),
  title text not null check (char_length(btrim(title)) between 1 and 240),
  message text,
  route text,
  entity_type text,
  entity_id text,
  source_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique(organization_id,recipient_user_id,source_key)
);
create index if not exists user_notifications_v2_inbox_idx
  on public.user_notifications_v2(organization_id,recipient_user_id,read_at,created_at desc);

create or replace function public.task_user_for_employee_v2(p_employee_record_id text)
returns uuid language sql stable security definer set search_path='' as $$
  select coalesce(
    (select link.auth_user_id from public.legacy_identity_links link
      where link.employee_record_id=p_employee_record_id and link.link_status='CONFIRMED' limit 1),
    (select profile.id from public.profiles profile where profile.employee_id=p_employee_record_id limit 1)
  );
$$;

create or replace function public.task_is_current_assignee_v2(p_assigned_user_id uuid,p_employee_record_id text)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and (
    p_assigned_user_id=auth.uid()
    or exists(select 1 from public.profiles profile where profile.id=auth.uid() and profile.employee_id=p_employee_record_id)
    or exists(select 1 from public.legacy_identity_links link where link.auth_user_id=auth.uid()
      and link.employee_record_id=p_employee_record_id and link.link_status='CONFIRMED')
  );
$$;

create or replace function public.can_read_task_v2(
  p_organization_id uuid,p_legacy_client_id text,p_assigned_user_id uuid,
  p_employee_record_id text,p_client_visible boolean
)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare member_role text;
begin
  if not public.is_active_org_member(p_organization_id)
     or not public.has_org_capability(p_organization_id,'work.read') then return false; end if;
  member_role:=public.current_member_role_key(p_organization_id);
  if member_role='client' then
    return p_client_visible is true and exists(select 1 from public.profiles profile
      where profile.id=auth.uid() and profile.client_id=p_legacy_client_id);
  end if;
  if public.has_org_capability(p_organization_id,'work.manage') then return true; end if;
  return public.task_is_current_assignee_v2(p_assigned_user_id,p_employee_record_id);
end;
$$;

create or replace function public.sync_task_projection_row_v2(p_record_id text)
returns void language plpgsql security definer set search_path='' as $$
declare record_row public.records%rowtype;
declare d jsonb;
declare client_uuid uuid;
declare assigned_uuid uuid;
declare start_value date;
declare due_value date;
declare completed_value timestamptz;
declare normalized_status text;
declare normalized_priority text;
begin
  select * into record_row from public.records record where record.id=p_record_id and record.coll='tasks';
  if record_row.id is null then return; end if;
  d:=coalesce(record_row.data,'{}'::jsonb);
  select client.id into client_uuid from public.client_accounts client
    where client.organization_id=record_row.organization_id and client.legacy_record_id=nullif(d->>'clientId','') and client.deleted_at is null limit 1;
  assigned_uuid:=public.task_user_for_employee_v2(nullif(d->>'assignedTo',''));
  if coalesce(d->>'startDate','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then start_value:=(d->>'startDate')::date; end if;
  if coalesce(d->>'dueDate','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then due_value:=(d->>'dueDate')::date; end if;
  begin completed_value:=nullif(d->>'completedAt','')::timestamptz; exception when others then completed_value:=null; end;
  normalized_status:=case when d->>'status' in ('Backlog','To Do','In Progress','Waiting for Client','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled') then d->>'status' else 'Backlog' end;
  normalized_priority:=case when d->>'priority' in ('Low','Normal','Medium','High','Urgent') then d->>'priority' else 'Normal' end;
  insert into public.work_tasks(
    organization_id,legacy_record_id,task_code,title,description,client_account_id,legacy_client_id,
    project_record_id,deliverable_record_id,assigned_employee_record_id,assigned_user_id,created_by_user_id,
    task_type,status,priority,start_date,due_date,completed_at,completed_by_user_id,estimated_hours,actual_hours,
    brief,requirements,reference_links,delivery_link,blockers,client_visible,created_at,updated_at,deleted_at
  ) values (
    record_row.organization_id,record_row.id,coalesce(nullif(d->>'taskCode',''),'TSK-'||upper(right(record_row.id,8))),
    left(coalesce(nullif(btrim(d->>'title'),''),nullif(btrim(d->>'name'),''),'Untitled task'),240),nullif(d->>'description',''),
    client_uuid,nullif(d->>'clientId',''),coalesce(nullif(d->>'projectId',''),'UNLINKED'),nullif(d->>'deliverableId',''),
    nullif(d->>'assignedTo',''),assigned_uuid,case when coalesce(d->>'createdBy','') ~ '^[a-f0-9-]{36}$' then (d->>'createdBy')::uuid else null end,
    nullif(d->>'taskType',''),normalized_status,normalized_priority,start_value,due_value,completed_value,
    case when coalesce(d->>'completedBy','') ~ '^[a-f0-9-]{36}$' then (d->>'completedBy')::uuid else null end,
    case when coalesce(d->>'estimatedHours','') ~ '^[0-9]+([.][0-9]+)?$' then (d->>'estimatedHours')::numeric else 0 end,
    case when coalesce(d->>'actualHours','') ~ '^[0-9]+([.][0-9]+)?$' then (d->>'actualHours')::numeric else 0 end,
    nullif(d->>'brief',''),nullif(d->>'requirements',''),nullif(d->>'referenceLinks',''),nullif(d->>'deliveryLink',''),
    nullif(d->>'blockers',''),case lower(coalesce(d->>'clientVisible','false')) when 'true' then true when '1' then true else false end,
    record_row.created_at,record_row.updated_at,
    case when record_row.deleted_at is not null or lower(coalesce(d->>'_del','false'))='true' then coalesce(record_row.deleted_at,now()) else null end
  ) on conflict(organization_id,legacy_record_id) do update set
    task_code=excluded.task_code,title=excluded.title,description=excluded.description,client_account_id=excluded.client_account_id,
    legacy_client_id=excluded.legacy_client_id,project_record_id=excluded.project_record_id,deliverable_record_id=excluded.deliverable_record_id,
    assigned_employee_record_id=excluded.assigned_employee_record_id,assigned_user_id=excluded.assigned_user_id,
    task_type=excluded.task_type,status=excluded.status,priority=excluded.priority,start_date=excluded.start_date,due_date=excluded.due_date,
    completed_at=excluded.completed_at,completed_by_user_id=excluded.completed_by_user_id,estimated_hours=excluded.estimated_hours,
    actual_hours=excluded.actual_hours,brief=excluded.brief,requirements=excluded.requirements,reference_links=excluded.reference_links,
    delivery_link=excluded.delivery_link,blockers=excluded.blockers,client_visible=excluded.client_visible,updated_at=excluded.updated_at,
    deleted_at=excluded.deleted_at,version=public.work_tasks.version+1;

  insert into public.task_projection_issues_v2(organization_id,legacy_record_id,issue_code)
  select record_row.organization_id,record_row.id,issue from unnest(array[
    case when nullif(d->>'projectId','') is null then 'MISSING_PROJECT' end,
    case when nullif(d->>'assignedTo','') is null then 'MISSING_ASSIGNEE' end,
    case when nullif(d->>'assignedTo','') is not null and assigned_uuid is null then 'ASSIGNEE_NOT_LINKED_TO_LOGIN' end,
    case when nullif(d->>'clientId','') is not null and client_uuid is null then 'CLIENT_NOT_CANONICAL' end
  ]) issue where issue is not null
  on conflict(organization_id,legacy_record_id,issue_code) do update set last_seen_at=now(),resolved_at=null;
  update public.task_projection_issues_v2 set resolved_at=now()
    where organization_id=record_row.organization_id and legacy_record_id=record_row.id and resolved_at is null
      and ((issue_code='MISSING_PROJECT' and nullif(d->>'projectId','') is not null)
        or (issue_code='MISSING_ASSIGNEE' and nullif(d->>'assignedTo','') is not null)
        or (issue_code='ASSIGNEE_NOT_LINKED_TO_LOGIN' and assigned_uuid is not null)
        or (issue_code='CLIENT_NOT_CANONICAL' and (nullif(d->>'clientId','') is null or client_uuid is not null)));
end;
$$;

create or replace function public.project_task_record_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.coll='tasks' then perform public.sync_task_projection_row_v2(new.id); end if;
  return new;
end;
$$;
drop trigger if exists project_task_record_v2 on public.records;
create trigger project_task_record_v2 after insert or update on public.records
for each row when (new.coll='tasks') execute function public.project_task_record_v2();

select public.sync_task_projection_row_v2(record.id) from public.records record where record.coll='tasks';
insert into public.task_events_v2(organization_id,task_id,action,note,occurred_at)
select task.organization_id,task.id,'IMPORTED','Projected from preserved legacy task',task.created_at
from public.work_tasks task
where not exists(select 1 from public.task_events_v2 event where event.task_id=task.id);

do $$ declare source_count integer; projected_count integer; begin
  select count(*) into source_count from public.records record where record.coll='tasks';
  select count(*) into projected_count from public.work_tasks;
  if source_count<>projected_count then raise exception 'M10 task projection mismatch: source %, projected %',source_count,projected_count; end if;
end $$;

create or replace function public.notification_role_key_v2(p_role text)
returns text language sql immutable set search_path='' as $$
  select case lower(regexp_replace(btrim(coalesce(p_role,'')),'[^a-zA-Z]+','_','g'))
    when 'owner' then 'owner' when 'admin' then 'admin' when 'manager' then 'manager'
    when 'project_manager' then 'manager' when 'marketing_director' then 'manager'
    when 'sales' then 'sales' when 'account_manager' then 'account_manager'
    when 'accountant' then 'finance' when 'finance' then 'finance' when 'hr' then 'hr'
    when 'content_creator' then 'content_creator' when 'social_media' then 'content_creator'
    when 'designer' then 'designer' when 'graphic_designer' then 'designer'
    when 'video_editor' then 'designer' when 'art_director' then 'designer'
    when 'client' then 'client' else null end;
$$;

create or replace function public.project_notification_record_v2(p_record_id text)
returns void language plpgsql security definer set search_path='' as $$
declare record_row public.records%rowtype; declare d jsonb; declare role_key text;
begin
  select * into record_row from public.records record where record.id=p_record_id and record.coll='notifications';
  if record_row.id is null or record_row.deleted_at is not null then return; end if;
  d:=coalesce(record_row.data,'{}'::jsonb); role_key:=public.notification_role_key_v2(d->>'role');
  insert into public.user_notifications_v2(
    organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key,read_at,created_at
  )
  select record_row.organization_id,recipient.user_id,coalesce(nullif(d->>'type',''),'INFO'),
    case when upper(coalesce(d->>'severity','')) in ('SUCCESS','WARNING','URGENT') then upper(d->>'severity') else 'INFO' end,
    left(coalesce(nullif(btrim(d->>'title'),''),'Notification'),240),nullif(d->>'message',''),
    coalesce(nullif(d->>'route',''),nullif(d->>'entityType','')),nullif(d->>'entityType',''),nullif(d->>'entityId',''),
    'legacy:'||record_row.id,case when lower(coalesce(d->>'read','false')) in ('true','1') then coalesce(record_row.updated_at,now()) else null end,
    coalesce(record_row.created_at,now())
  from (
    select distinct membership.user_id
    from public.organization_members membership
    join public.organization_roles role on role.id=membership.role_id
    left join public.profiles profile on profile.id=membership.user_id
    left join public.legacy_identity_links link on link.auth_user_id=membership.user_id and link.link_status='CONFIRMED'
    where membership.organization_id=record_row.organization_id and membership.status='ACTIVE'
      and (
        (nullif(d->>'userId','') is not null and (membership.user_id::text=d->>'userId' or profile.employee_id=d->>'userId'
          or link.employee_record_id=d->>'userId' or link.legacy_account_row_id=d->>'userId'))
        or (nullif(d->>'userId','') is null and role_key is not null and role.key=role_key)
        or (nullif(d->>'userId','') is null and role_key is null)
      )
  ) recipient
  on conflict(organization_id,recipient_user_id,source_key) do update set
    title=excluded.title,message=excluded.message,route=excluded.route,entity_type=excluded.entity_type,
    entity_id=excluded.entity_id,severity=excluded.severity;
end;
$$;

create or replace function public.project_notification_record_v2_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin if new.coll='notifications' then perform public.project_notification_record_v2(new.id); end if; return new; end; $$;
drop trigger if exists project_notification_record_v2 on public.records;
create trigger project_notification_record_v2 after insert on public.records
for each row when (new.coll='notifications') execute function public.project_notification_record_v2_trigger();
select public.project_notification_record_v2(record.id) from public.records record where record.coll='notifications';

create or replace function public.task_events_v2_append_only()
returns trigger language plpgsql set search_path='' as $$ begin raise exception using errcode='42501',message='task_events_append_only'; end; $$;
drop trigger if exists task_events_v2_no_mutation on public.task_events_v2;
create trigger task_events_v2_no_mutation before update or delete on public.task_events_v2
for each row execute function public.task_events_v2_append_only();

create or replace function public.list_tasks_v2(
  p_organization_id uuid,p_scope text default 'ALL',p_status text default null,p_search text default null,
  p_client_account_id uuid default null,p_project_record_id text default null,p_page integer default 1,p_page_size integer default 50
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page_value integer:=greatest(1,coalesce(p_page,1)); declare size_value integer:=least(100,greatest(1,coalesce(p_page_size,50)));
declare total_value integer; declare items_value jsonb; declare counts_value jsonb;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='membership_required'; end if;
  with filtered as (
    select task.* from public.work_tasks task where task.organization_id=p_organization_id and task.deleted_at is null
      and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible)
      and (upper(coalesce(p_scope,'ALL'))<>'MINE' or public.task_is_current_assignee_v2(task.assigned_user_id,task.assigned_employee_record_id))
      and (nullif(p_status,'') is null or task.status=p_status)
      and (nullif(btrim(coalesce(p_search,'')),'') is null or task.title ilike '%'||btrim(p_search)||'%' or task.task_code ilike '%'||btrim(p_search)||'%')
      and (p_client_account_id is null or task.client_account_id=p_client_account_id)
      and (nullif(p_project_record_id,'') is null or task.project_record_id=p_project_record_id)
  ), page_rows as (select * from filtered order by case when status='Done' then 1 else 0 end,due_date nulls last,updated_at desc offset (page_value-1)*size_value limit size_value)
  select (select count(*) from filtered),coalesce(jsonb_agg(jsonb_build_object(
    'id',task.id,'legacyRecordId',task.legacy_record_id,'taskCode',task.task_code,'title',task.title,'description',task.description,
    'clientAccountId',task.client_account_id,'clientId',task.legacy_client_id,'projectId',task.project_record_id,
    'deliverableId',task.deliverable_record_id,'assignedTo',task.assigned_employee_record_id,'assignedUserId',task.assigned_user_id,
    'status',task.status,'priority',task.priority,'taskType',task.task_type,'startDate',task.start_date,'dueDate',task.due_date,
    'completedAt',task.completed_at,'estimatedHours',task.estimated_hours,'actualHours',task.actual_hours,
    'brief',task.brief,'requirements',task.requirements,'referenceLinks',task.reference_links,'deliveryLink',task.delivery_link,
    'blockers',task.blockers,'clientVisible',task.client_visible,'version',task.version,'updatedAt',task.updated_at,
    'canManage',public.has_org_capability(task.organization_id,'work.manage'),
    'canChangeStatus',public.has_org_capability(task.organization_id,'work.manage') or public.task_is_current_assignee_v2(task.assigned_user_id,task.assigned_employee_record_id)
  ) order by case when task.status='Done' then 1 else 0 end,task.due_date nulls last,task.updated_at desc),'[]'::jsonb)
  into total_value,items_value from page_rows task;
  select coalesce(jsonb_object_agg(status,total),'{}'::jsonb) into counts_value from (
    select task.status,count(*)::integer total from public.work_tasks task where task.organization_id=p_organization_id and task.deleted_at is null
      and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible) group by task.status
  ) grouped;
  return jsonb_build_object('items',items_value,'total',total_value,'counts',counts_value,'page',page_value,'pageSize',size_value,'pages',greatest(1,ceil(total_value::numeric/size_value)::integer));
end;
$$;

create or replace function public.get_task_v2(p_organization_id uuid,p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype;
begin
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null;
  if task_row.id is null or not public.can_read_task_v2(task_row.organization_id,task_row.legacy_client_id,task_row.assigned_user_id,task_row.assigned_employee_record_id,task_row.client_visible) then return jsonb_build_object('ok',false,'error','not_found'); end if;
  return jsonb_build_object('ok',true,'task',(public.list_tasks_v2(p_organization_id,'ALL',null,task_row.task_code,null,null,1,1)->'items'->0),
    'timeline',coalesce((select jsonb_agg(jsonb_build_object('id',event.id,'action',event.action,'fromStatus',event.from_status,'toStatus',event.to_status,'note',event.note,'occurredAt',event.occurred_at) order by event.occurred_at desc) from public.task_events_v2 event where event.task_id=task_row.id),'[]'::jsonb),
    'comments',coalesce((select jsonb_agg(jsonb_build_object('id',comment.id,'body',comment.body,'visibility',comment.visibility,'authorUserId',comment.author_user_id,'createdAt',comment.created_at) order by comment.created_at) from public.task_comments_v2 comment where comment.task_id=task_row.id and comment.deleted_at is null and (public.current_member_role_key(p_organization_id)<>'client' or comment.visibility='CLIENT')),'[]'::jsonb),
    'documents',coalesce((select jsonb_agg(jsonb_build_object('id',document.id,'title',document.title,'documentType',document.document_type,'mimeType',document.mime_type,'status',document.status) order by link.created_at desc) from public.task_document_links_v2 link join public.document_files document on document.id=link.document_id where link.task_id=task_row.id and document.deleted_at is null and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)),'[]'::jsonb));
end;
$$;

create or replace function public.create_task_v2(
  p_organization_id uuid,p_title text,p_client_account_id uuid,p_project_record_id text,p_assigned_employee_record_id text,
  p_status text default 'Backlog',p_priority text default 'Normal',p_task_type text default null,p_start_date date default null,
  p_due_date date default null,p_estimated_hours numeric default 0,p_brief text default null,p_requirements text default null,
  p_reference_links text default null,p_client_visible boolean default false
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare client_row public.client_accounts%rowtype; declare assigned_uuid uuid; declare legacy_id text:='tsk-'||replace(gen_random_uuid()::text,'-',''); declare task_uuid uuid; declare task_data jsonb;
begin
  if not public.has_org_capability(p_organization_id,'work.manage') then raise exception using errcode='42501',message='work_manage_required'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then raise exception 'invalid_task_title'; end if;
  if coalesce(p_status,'Backlog') not in ('Backlog','To Do','In Progress','Waiting for Client','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled') then raise exception 'invalid_task_status'; end if;
  if coalesce(p_priority,'Normal') not in ('Low','Normal','Medium','High','Urgent') then raise exception 'invalid_task_priority'; end if;
  if p_due_date is not null and p_start_date is not null and p_due_date<p_start_date then raise exception 'invalid_task_dates'; end if;
  select * into client_row from public.client_accounts client where client.organization_id=p_organization_id and client.id=p_client_account_id and client.deleted_at is null;
  if client_row.id is null then raise exception using errcode='23503',message='task_client_not_found'; end if;
  if not exists(select 1 from public.records project where project.organization_id=p_organization_id and project.id=p_project_record_id and project.coll='projects' and project.deleted_at is null and project.data->>'clientId'=client_row.legacy_record_id) then raise exception using errcode='23503',message='task_project_client_mismatch'; end if;
  if not exists(select 1 from public.records employee where employee.organization_id=p_organization_id and employee.id=p_assigned_employee_record_id and employee.coll='employees' and employee.deleted_at is null) then raise exception using errcode='23503',message='task_assignee_not_found'; end if;
  assigned_uuid:=public.task_user_for_employee_v2(p_assigned_employee_record_id);
  task_data:=jsonb_build_object('id',legacy_id,'taskCode','TSK-'||upper(left(replace(legacy_id,'tsk-',''),8)),'title',btrim(p_title),
    'clientId',client_row.legacy_record_id,'projectId',p_project_record_id,'assignedTo',p_assigned_employee_record_id,
    'createdBy',auth.uid(),'status',coalesce(p_status,'Backlog'),'priority',coalesce(p_priority,'Normal'),'taskType',coalesce(p_task_type,''),
    'startDate',coalesce(p_start_date::text,''),'dueDate',coalesce(p_due_date::text,''),'estimatedHours',greatest(0,coalesce(p_estimated_hours,0)),
    'brief',coalesce(p_brief,''),'requirements',coalesce(p_requirements,''),'referenceLinks',coalesce(p_reference_links,''),
    'clientVisible',coalesce(p_client_visible,false),'createdAt',now(),'updatedAt',now());
  insert into public.records(id,coll,data,organization_id) values(legacy_id,'tasks',task_data,p_organization_id);
  select id into task_uuid from public.work_tasks where organization_id=p_organization_id and legacy_record_id=legacy_id;
  insert into public.task_events_v2(organization_id,task_id,action,to_status,note,actor_user_id) values(p_organization_id,task_uuid,'CREATED',coalesce(p_status,'Backlog'),'Task created',auth.uid());
  if assigned_uuid is not null then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(p_organization_id,assigned_uuid,'TASK_ASSIGNED','INFO','New task assigned',btrim(p_title),'tasks','tasks',task_uuid::text,'task-assigned:'||task_uuid::text||':1') on conflict do nothing;
  end if;
  return public.get_task_v2(p_organization_id,task_uuid);
end;
$$;

create or replace function public.update_task_v2(
  p_organization_id uuid,p_task_id uuid,p_expected_version integer,p_title text,p_client_account_id uuid,
  p_project_record_id text,p_assigned_employee_record_id text,p_priority text,p_task_type text,p_start_date date,p_due_date date,
  p_estimated_hours numeric,p_brief text,p_requirements text,p_reference_links text,p_delivery_link text,p_blockers text,p_client_visible boolean
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare client_row public.client_accounts%rowtype; declare assigned_uuid uuid;
begin
  if not public.has_org_capability(p_organization_id,'work.manage') then raise exception using errcode='42501',message='work_manage_required'; end if;
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null for update;
  if task_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if task_row.version<>p_expected_version then raise exception using errcode='40001',message='task_version_conflict'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then raise exception 'invalid_task_title'; end if;
  if p_priority not in ('Low','Normal','Medium','High','Urgent') then raise exception 'invalid_task_priority'; end if;
  if p_due_date is not null and p_start_date is not null and p_due_date<p_start_date then raise exception 'invalid_task_dates'; end if;
  select * into client_row from public.client_accounts client where client.organization_id=p_organization_id and client.id=p_client_account_id and client.deleted_at is null;
  if client_row.id is null then raise exception using errcode='23503',message='task_client_not_found'; end if;
  if not exists(select 1 from public.records project where project.organization_id=p_organization_id and project.id=p_project_record_id and project.coll='projects' and project.deleted_at is null and project.data->>'clientId'=client_row.legacy_record_id) then raise exception using errcode='23503',message='task_project_client_mismatch'; end if;
  if not exists(select 1 from public.records employee where employee.organization_id=p_organization_id and employee.id=p_assigned_employee_record_id and employee.coll='employees' and employee.deleted_at is null) then raise exception using errcode='23503',message='task_assignee_not_found'; end if;
  assigned_uuid:=public.task_user_for_employee_v2(p_assigned_employee_record_id);
  update public.records set data=data||jsonb_build_object('title',btrim(p_title),'name',btrim(p_title),'clientId',client_row.legacy_record_id,
    'projectId',p_project_record_id,'assignedTo',p_assigned_employee_record_id,'priority',p_priority,'taskType',coalesce(p_task_type,''),
    'startDate',coalesce(p_start_date::text,''),'dueDate',coalesce(p_due_date::text,''),'estimatedHours',greatest(0,coalesce(p_estimated_hours,0)),
    'brief',coalesce(p_brief,''),'requirements',coalesce(p_requirements,''),'referenceLinks',coalesce(p_reference_links,''),
    'deliveryLink',coalesce(p_delivery_link,''),'blockers',coalesce(p_blockers,''),'clientVisible',coalesce(p_client_visible,false),'updatedAt',now()),updated_at=now()
  where organization_id=p_organization_id and id=task_row.legacy_record_id;
  insert into public.task_events_v2(organization_id,task_id,action,note,actor_user_id,safe_context)
  values(p_organization_id,p_task_id,'UPDATED','Task details updated',auth.uid(),jsonb_build_object('assigneeChanged',task_row.assigned_employee_record_id is distinct from p_assigned_employee_record_id));
  if assigned_uuid is not null and task_row.assigned_employee_record_id is distinct from p_assigned_employee_record_id then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(p_organization_id,assigned_uuid,'TASK_ASSIGNED','INFO','Task assigned to you',btrim(p_title),'tasks','tasks',p_task_id::text,'task-reassigned:'||p_task_id::text||':'||(task_row.version+1)::text) on conflict do nothing;
  end if;
  return public.get_task_v2(p_organization_id,p_task_id);
end;
$$;

create or replace function public.change_task_status_v2(
  p_organization_id uuid,p_task_id uuid,p_expected_version integer,p_status text,p_note text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare manager boolean; declare allowed boolean:=false; declare completion_value text;
begin
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null for update;
  if task_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  manager:=public.has_org_capability(p_organization_id,'work.manage');
  if not manager and not public.task_is_current_assignee_v2(task_row.assigned_user_id,task_row.assigned_employee_record_id) then raise exception using errcode='42501',message='task_status_not_allowed'; end if;
  if task_row.version<>p_expected_version then raise exception using errcode='40001',message='task_version_conflict'; end if;
  if p_status not in ('Backlog','To Do','In Progress','Waiting for Client','Internal Review','Client Review','Revisions','Approved','Scheduled','Delivered','Done','Blocked','Cancelled') then raise exception 'invalid_task_status'; end if;
  allowed:=case task_row.status
    when 'Backlog' then p_status in ('To Do','In Progress','Blocked','Cancelled')
    when 'To Do' then p_status in ('In Progress','Blocked','Cancelled')
    when 'In Progress' then p_status in ('Waiting for Client','Internal Review','Done','Blocked','Cancelled')
    when 'Waiting for Client' then p_status in ('In Progress','Internal Review','Client Review','Blocked','Cancelled')
    when 'Internal Review' then p_status in ('In Progress','Client Review','Done','Blocked')
    when 'Client Review' then p_status in ('Revisions','Approved','Done','Blocked')
    when 'Revisions' then p_status in ('In Progress','Internal Review','Blocked')
    when 'Approved' then p_status in ('Scheduled','Delivered','Done')
    when 'Scheduled' then p_status in ('Delivered','Done')
    when 'Delivered' then p_status='Done'
    when 'Blocked' then p_status in ('To Do','In Progress','Cancelled')
    when 'Done' then manager and p_status='In Progress'
    when 'Cancelled' then manager and p_status='Backlog' else false end;
  if not allowed then raise exception using errcode='P0001',message='invalid_task_transition'; end if;
  if not manager and p_status not in ('In Progress','Waiting for Client','Internal Review','Done','Blocked') then raise exception using errcode='42501',message='assignee_transition_not_allowed'; end if;
  completion_value:=case when p_status='Done' then now()::text when task_row.status='Done' then '' else coalesce(task_row.completed_at::text,'') end;
  update public.records set data=data||jsonb_build_object('status',p_status,'completedAt',completion_value,
    'completedBy',case when p_status='Done' then auth.uid()::text when task_row.status='Done' then '' else coalesce((data->>'completedBy'),'') end,
    'blockers',case when p_status='Blocked' then coalesce(nullif(btrim(p_note),''),coalesce(data->>'blockers','')) else coalesce(data->>'blockers','') end,'updatedAt',now()),updated_at=now()
  where organization_id=p_organization_id and id=task_row.legacy_record_id;
  insert into public.task_events_v2(organization_id,task_id,action,from_status,to_status,note,actor_user_id)
  values(p_organization_id,p_task_id,'STATUS_CHANGED',task_row.status,p_status,nullif(btrim(coalesce(p_note,'')),''),auth.uid());
  if task_row.created_by_user_id is not null and task_row.created_by_user_id<>auth.uid() then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(p_organization_id,task_row.created_by_user_id,'TASK_STATUS',case when p_status='Blocked' then 'WARNING' when p_status='Done' then 'SUCCESS' else 'INFO' end,
      'Task status updated',task_row.title||' → '||p_status,'tasks','tasks',p_task_id::text,'task-status:'||p_task_id::text||':'||(task_row.version+1)::text) on conflict do nothing;
  end if;
  return public.get_task_v2(p_organization_id,p_task_id);
end;
$$;

create or replace function public.add_task_comment_v2(p_organization_id uuid,p_task_id uuid,p_body text,p_visibility text default 'INTERNAL')
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare visibility_value text:=upper(coalesce(p_visibility,'INTERNAL')); declare comment_row public.task_comments_v2%rowtype;
begin
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null;
  if task_row.id is null or not public.can_read_task_v2(task_row.organization_id,task_row.legacy_client_id,task_row.assigned_user_id,task_row.assigned_employee_record_id,task_row.client_visible) then raise exception using errcode='42501',message='task_read_required'; end if;
  if char_length(btrim(coalesce(p_body,''))) not between 1 and 4000 then raise exception 'invalid_task_comment'; end if;
  if public.current_member_role_key(p_organization_id)='client' then visibility_value:='CLIENT'; end if;
  if visibility_value not in ('INTERNAL','CLIENT') then raise exception 'invalid_comment_visibility'; end if;
  insert into public.task_comments_v2(organization_id,task_id,author_user_id,visibility,body)
  values(p_organization_id,p_task_id,auth.uid(),visibility_value,btrim(p_body)) returning * into comment_row;
  insert into public.task_events_v2(organization_id,task_id,action,note,actor_user_id,safe_context)
  values(p_organization_id,p_task_id,'COMMENTED','Comment added',auth.uid(),jsonb_build_object('visibility',visibility_value));
  return jsonb_build_object('ok',true,'id',comment_row.id,'createdAt',comment_row.created_at);
end;
$$;

create or replace function public.link_task_document_v2(p_organization_id uuid,p_task_id uuid,p_document_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_row public.work_tasks%rowtype; declare document_row public.document_files%rowtype;
begin
  select * into task_row from public.work_tasks task where task.organization_id=p_organization_id and task.id=p_task_id and task.deleted_at is null;
  if task_row.id is null or not (public.has_org_capability(p_organization_id,'work.manage') or public.task_is_current_assignee_v2(task_row.assigned_user_id,task_row.assigned_employee_record_id)) then raise exception using errcode='42501',message='task_update_required'; end if;
  select * into document_row from public.document_files document where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null and document.status='ACTIVE';
  if document_row.id is null or not public.can_read_document_v2(document_row.organization_id,document_row.visibility,document_row.legacy_client_id,document_row.employee_record_id) then raise exception using errcode='42501',message='document_read_required'; end if;
  insert into public.task_document_links_v2(organization_id,task_id,document_id,linked_by_user_id)
  values(p_organization_id,p_task_id,p_document_id,auth.uid()) on conflict do nothing;
  insert into public.task_events_v2(organization_id,task_id,action,note,actor_user_id,safe_context)
  values(p_organization_id,p_task_id,'DOCUMENT_LINKED','Document linked',auth.uid(),jsonb_build_object('documentId',p_document_id));
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.list_notifications_v2(p_organization_id uuid,p_unread_only boolean default false,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='membership_required'; end if;
  return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',notification.id,'type',notification.notification_type,'severity',notification.severity,'title',notification.title,
    'message',notification.message,'route',notification.route,'entityType',notification.entity_type,'entityId',notification.entity_id,
    'read',notification.read_at is not null,'readAt',notification.read_at,'createdAt',notification.created_at
  ) order by notification.created_at desc) from (select * from public.user_notifications_v2 notification
    where notification.organization_id=p_organization_id and notification.recipient_user_id=auth.uid()
      and (p_unread_only is not true or notification.read_at is null) and (notification.expires_at is null or notification.expires_at>now())
    order by notification.created_at desc limit least(200,greatest(1,coalesce(p_limit,100)))) notification),'[]'::jsonb),
    'unread',(select count(*)::integer from public.user_notifications_v2 notification where notification.organization_id=p_organization_id and notification.recipient_user_id=auth.uid() and notification.read_at is null and (notification.expires_at is null or notification.expires_at>now())));
end;
$$;

create or replace function public.mark_notifications_read_v2(p_organization_id uuid,p_notification_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='membership_required'; end if;
  update public.user_notifications_v2 set read_at=coalesce(read_at,now())
  where organization_id=p_organization_id and recipient_user_id=auth.uid() and (p_notification_id is null or id=p_notification_id);
  get diagnostics changed=row_count;
  return jsonb_build_object('ok',true,'changed',changed);
end;
$$;

create or replace function public.global_search_v2(p_organization_id uuid,p_query text,p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q text:=btrim(coalesce(p_query,'')); declare result jsonb;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='membership_required'; end if;
  if char_length(q)<2 then return jsonb_build_object('items','[]'::jsonb); end if;
  with candidates as (
    select 'task'::text kind,task.id::text id,task.title,task.task_code||' · '||task.status subtitle,'tasks'::text route,task.updated_at,
      case when lower(task.title) like lower(q)||'%' then 100 else 70 end rank
    from public.work_tasks task where task.organization_id=p_organization_id and task.deleted_at is null
      and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible)
      and (task.title ilike '%'||q||'%' or task.task_code ilike '%'||q||'%')
    union all
    select 'client',client.legacy_record_id,client.name,coalesce(client.industry,'Client'),'clients',client.updated_at,case when lower(client.name) like lower(q)||'%' then 100 else 70 end
    from public.client_accounts client where client.organization_id=p_organization_id and client.deleted_at is null
      and public.has_org_capability(p_organization_id,'clients.read')
      and (public.current_member_role_key(p_organization_id)<>'client' or exists(select 1 from public.profiles profile where profile.id=auth.uid() and profile.client_id=client.legacy_record_id))
      and (client.name ilike '%'||q||'%' or coalesce(client.industry,'') ilike '%'||q||'%')
    union all
    select 'project',record.id,coalesce(record.data->>'projectName',record.data->>'name','Project'),coalesce(record.data->>'status','Project'),'projects',record.updated_at,70
    from public.records record where record.organization_id=p_organization_id and record.coll='projects' and record.deleted_at is null
      and public.records_can_read(record.organization_id,record.coll,record.data)
      and (coalesce(record.data->>'projectName','') ilike '%'||q||'%' or coalesce(record.data->>'name','') ilike '%'||q||'%')
    union all
    select 'lead',lead.legacy_record_id,lead.name,coalesce(lead.company,lead.stage),'leads',lead.updated_at,70
    from public.crm_leads lead where lead.organization_id=p_organization_id and lead.deleted_at is null
      and public.has_org_capability(p_organization_id,'clients.read') and public.current_member_role_key(p_organization_id)<>'client'
      and (lead.name ilike '%'||q||'%' or coalesce(lead.company,'') ilike '%'||q||'%' or coalesce(lead.phone,'') ilike '%'||q||'%')
    union all
    select 'contract',contract.legacy_record_id,contract.title,contract.contract_number||' · '||contract.status,'contracts',contract.updated_at,70
    from public.agency_contracts contract where contract.organization_id=p_organization_id and contract.deleted_at is null
      and public.has_org_capability(p_organization_id,'clients.read')
      and (contract.title ilike '%'||q||'%' or contract.contract_number ilike '%'||q||'%')
    union all
    select 'invoice',invoice.legacy_record_id,invoice.invoice_number,invoice.status||' · '||invoice.currency,'invoices',invoice.updated_at,70
    from public.finance_invoices invoice where invoice.organization_id=p_organization_id and invoice.deleted_at is null
      and public.has_org_capability(p_organization_id,'finance.read') and invoice.invoice_number ilike '%'||q||'%'
    union all
    select 'document',document.id::text,document.title,document.document_type,'documents',document.updated_at,70
    from public.document_files document where document.organization_id=p_organization_id and document.deleted_at is null and document.status in ('ACTIVE','ARCHIVED')
      and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)
      and (document.title ilike '%'||q||'%' or coalesce(document.reference_number,'') ilike '%'||q||'%')
    union all
    select 'applicant',applicant.legacy_record_id,applicant.full_name,applicant.stage||' · Applicant','candidates',applicant.updated_at,70
    from public.applicants applicant where applicant.organization_id=p_organization_id and applicant.deleted_at is null
      and public.has_org_capability(p_organization_id,'hr.read') and (applicant.full_name ilike '%'||q||'%' or coalesce(applicant.position,'') ilike '%'||q||'%')
  ), limited as (select * from candidates order by rank desc,updated_at desc limit least(50,greatest(1,coalesce(p_limit,30))))
  select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'title',title,'subtitle',subtitle,'route',route) order by rank desc,updated_at desc),'[]'::jsonb) into result from limited;
  return jsonb_build_object('items',result);
end;
$$;

alter table public.work_tasks enable row level security;
alter table public.task_events_v2 enable row level security;
alter table public.task_comments_v2 enable row level security;
alter table public.task_document_links_v2 enable row level security;
alter table public.task_projection_issues_v2 enable row level security;
alter table public.user_notifications_v2 enable row level security;
revoke all privileges on public.work_tasks,public.task_events_v2,public.task_comments_v2,public.task_document_links_v2,public.task_projection_issues_v2,public.user_notifications_v2 from public,anon,authenticated;
grant select,insert,update,delete on public.work_tasks,public.task_events_v2,public.task_comments_v2,public.task_document_links_v2,public.task_projection_issues_v2,public.user_notifications_v2 to service_role;
grant usage,select on sequence public.task_events_v2_id_seq,public.task_projection_issues_v2_id_seq to service_role;
grant select on public.work_tasks,public.task_events_v2,public.task_comments_v2,public.task_document_links_v2,public.task_projection_issues_v2,public.user_notifications_v2 to authenticated;

create policy work_tasks_authorized_read on public.work_tasks for select to authenticated
using (deleted_at is null and public.can_read_task_v2(organization_id,legacy_client_id,assigned_user_id,assigned_employee_record_id,client_visible));
create policy task_events_v2_authorized_read on public.task_events_v2 for select to authenticated
using (exists(select 1 from public.work_tasks task where task.id=task_events_v2.task_id and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible)));
create policy task_comments_v2_authorized_read on public.task_comments_v2 for select to authenticated
using (deleted_at is null and exists(select 1 from public.work_tasks task where task.id=task_comments_v2.task_id and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible) and (public.current_member_role_key(task.organization_id)<>'client' or visibility='CLIENT')));
create policy task_document_links_v2_authorized_read on public.task_document_links_v2 for select to authenticated
using (exists(select 1 from public.work_tasks task where task.id=task_document_links_v2.task_id and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible)));
create policy task_projection_issues_v2_manager_read on public.task_projection_issues_v2 for select to authenticated
using (public.has_org_capability(organization_id,'work.manage'));
create policy user_notifications_v2_self_read on public.user_notifications_v2 for select to authenticated
using (recipient_user_id=auth.uid() and public.is_active_org_member(organization_id));

revoke all on function public.task_user_for_employee_v2(text) from public,anon;
revoke all on function public.task_is_current_assignee_v2(uuid,text) from public,anon;
revoke all on function public.can_read_task_v2(uuid,text,uuid,text,boolean) from public,anon;
revoke all on function public.sync_task_projection_row_v2(text) from public,anon,authenticated;
revoke all on function public.project_notification_record_v2(text) from public,anon,authenticated;
revoke all on function public.list_tasks_v2(uuid,text,text,text,uuid,text,integer,integer) from public,anon;
revoke all on function public.get_task_v2(uuid,uuid) from public,anon;
revoke all on function public.create_task_v2(uuid,text,uuid,text,text,text,text,text,date,date,numeric,text,text,text,boolean) from public,anon;
revoke all on function public.update_task_v2(uuid,uuid,integer,text,uuid,text,text,text,text,date,date,numeric,text,text,text,text,text,boolean) from public,anon;
revoke all on function public.change_task_status_v2(uuid,uuid,integer,text,text) from public,anon;
revoke all on function public.add_task_comment_v2(uuid,uuid,text,text) from public,anon;
revoke all on function public.link_task_document_v2(uuid,uuid,uuid) from public,anon;
revoke all on function public.list_notifications_v2(uuid,boolean,integer) from public,anon;
revoke all on function public.mark_notifications_read_v2(uuid,uuid) from public,anon;
revoke all on function public.global_search_v2(uuid,text,integer) from public,anon;
grant execute on function public.task_user_for_employee_v2(text) to authenticated,service_role;
grant execute on function public.task_is_current_assignee_v2(uuid,text) to authenticated,service_role;
grant execute on function public.can_read_task_v2(uuid,text,uuid,text,boolean) to authenticated,service_role;
grant execute on function public.list_tasks_v2(uuid,text,text,text,uuid,text,integer,integer) to authenticated,service_role;
grant execute on function public.get_task_v2(uuid,uuid) to authenticated,service_role;
grant execute on function public.create_task_v2(uuid,text,uuid,text,text,text,text,text,date,date,numeric,text,text,text,boolean) to authenticated,service_role;
grant execute on function public.update_task_v2(uuid,uuid,integer,text,uuid,text,text,text,text,date,date,numeric,text,text,text,text,text,boolean) to authenticated,service_role;
grant execute on function public.change_task_status_v2(uuid,uuid,integer,text,text) to authenticated,service_role;
grant execute on function public.add_task_comment_v2(uuid,uuid,text,text) to authenticated,service_role;
grant execute on function public.link_task_document_v2(uuid,uuid,uuid) to authenticated,service_role;
grant execute on function public.list_notifications_v2(uuid,boolean,integer) to authenticated,service_role;
grant execute on function public.mark_notifications_read_v2(uuid,uuid) to authenticated,service_role;
grant execute on function public.global_search_v2(uuid,text,integer) to authenticated,service_role;

insert into public.migration_audit(migration,note) values(
  '20260826023000_tasks_search_notifications_v2',
  'Added canonical task projection, assignee-safe status commands, comments and document links, per-user actionable notifications, permission-aware global search, RLS, data-quality inventory, and rollback-safe legacy compatibility.'
);

commit;

-- Forward-only rollback: route the UI back to legacy Tasks and local command
-- search, then revoke authenticated execution of the M10 RPCs. Preserve task
-- projections, events, comments, links, notification receipts, and issue rows.
