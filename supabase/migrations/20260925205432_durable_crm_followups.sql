-- Additive CRM next-action chain. No legacy dates, owners or outcomes are inferred.
begin;
create table if not exists public.crm_followups_v2 (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  lead_id uuid not null,
  owner_user_id uuid not null,
  title text not null check(char_length(btrim(title)) between 1 and 240),
  due_at timestamptz not null,
  source_timezone text not null,
  status text not null default 'OPEN' check(status in('OPEN','DONE','CANCELLED')),
  outcome text check(char_length(outcome)<=5000),
  previous_id uuid,
  version integer not null default 1 check(version>0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(organization_id,id),
  unique(previous_id),
  foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete restrict,
  foreign key(organization_id,owner_user_id) references public.organization_members(organization_id,user_id) on delete restrict,
  foreign key(organization_id,previous_id) references public.crm_followups_v2(organization_id,id) on delete restrict,
  check((status='OPEN' and completed_at is null) or (status<>'OPEN' and completed_at is not null)),
  check(status='OPEN' or char_length(btrim(coalesce(outcome,'')))>0)
);
create index if not exists crm_followups_v2_due on public.crm_followups_v2(organization_id,owner_user_id,due_at) where status='OPEN';
create table if not exists public.crm_followup_commands_v2 (
 organization_id uuid not null references public.organizations(id) on delete restrict,
 command_id uuid not null,
 actor_user_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,command_id)
);
alter table public.crm_followups_v2 enable row level security;
alter table public.crm_followup_commands_v2 enable row level security;
revoke all on public.crm_followups_v2,public.crm_followup_commands_v2 from anon,authenticated;
grant select on public.crm_followups_v2 to authenticated;
grant all on public.crm_followups_v2,public.crm_followup_commands_v2 to service_role;
create policy crm_followups_v2_read on public.crm_followups_v2 for select to authenticated
 using(public.has_org_capability(organization_id,'clients.read') and public.current_member_role_key(organization_id)<>'client');

create or replace function public.list_crm_followups_v2(p_organization_id uuid,p_legacy_record_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare lead_uuid uuid;
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then
  raise exception using errcode='42501',message='crm_read_required';
 end if;
 select id into lead_uuid from public.crm_leads where organization_id=p_organization_id and legacy_record_id=p_legacy_record_id and deleted_at is null;
 if lead_uuid is null then raise exception 'lead_not_found'; end if;
 return jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(to_jsonb(f) order by (f.status='OPEN') desc,f.due_at) from public.crm_followups_v2 f where f.organization_id=p_organization_id and f.lead_id=lead_uuid),'[]'::jsonb),
 'owners',coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id,'name',p.display_name) order by p.display_name)
 from public.organization_members m join public.profiles p on p.id=m.user_id
 join public.organization_roles r on r.id=m.role_id and r.organization_id=m.organization_id
 where m.organization_id=p_organization_id and m.status='ACTIVE' and p.identity_status='ACTIVE' and r.key<>'client'
 and exists(select 1 from public.role_capabilities rc join public.capabilities c on c.id=rc.capability_id where rc.role_id=m.role_id and c.key='clients.read')),'[]'::jsonb));
end; $$;

create or replace function public.save_crm_followup_v2(
 p_organization_id uuid,p_legacy_record_id text,p_command_id uuid,p_id uuid,p_expected_version integer,
 p_title text,p_due_at timestamptz,p_source_timezone text,p_owner_user_id uuid,
 p_status text default 'OPEN',p_outcome text default null,p_next_action jsonb default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 old_row public.crm_followups_v2%rowtype;
 lead_uuid uuid;
 requested jsonb;
 saved public.crm_followup_commands_v2%rowtype;
 result_value jsonb;
 next_id uuid;
 next_due timestamptz;
begin
 if not public.has_org_capability(p_organization_id,'clients.manage') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then
  raise exception using errcode='42501',message='crm_manage_required';
 end if;
 if p_command_id is null or p_id is null then raise exception 'command_id_required'; end if;
 requested=jsonb_build_object('lead',p_legacy_record_id,'id',p_id,'version',p_expected_version,'title',p_title,'due',p_due_at,'timezone',p_source_timezone,'owner',p_owner_user_id,'status',p_status,'outcome',p_outcome,'next',p_next_action);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into saved from public.crm_followup_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then
  if saved.actor_user_id<>auth.uid() or saved.request<>requested then raise exception using errcode='22023',message='idempotency_conflict'; end if;
  return saved.result||jsonb_build_object('replayed',true);
 end if;
 select id into lead_uuid from public.crm_leads where organization_id=p_organization_id and legacy_record_id=p_legacy_record_id and deleted_at is null for share;
 if lead_uuid is null then raise exception 'lead_not_found'; end if;
 if p_title is null or char_length(btrim(p_title)) not between 1 and 240 or p_due_at is null or not isfinite(p_due_at) or p_status is null or p_status not in('OPEN','DONE','CANCELLED')
 or p_source_timezone is null or not exists(select 1 from pg_timezone_names where name=p_source_timezone) then raise exception 'invalid_followup'; end if;
 if not exists(select 1 from public.organization_members m join public.profiles p on p.id=m.user_id
  join public.organization_roles r on r.id=m.role_id and r.organization_id=m.organization_id
  where m.organization_id=p_organization_id and m.user_id=p_owner_user_id and m.status='ACTIVE' and p.identity_status='ACTIVE' and r.key<>'client'
  and exists(select 1 from public.role_capabilities rc join public.capabilities c on c.id=rc.capability_id where rc.role_id=m.role_id and c.key='clients.read')) then raise exception using errcode='42501',message='ineligible_followup_owner'; end if;
 select * into old_row from public.crm_followups_v2 where organization_id=p_organization_id and id=p_id for update;
 if old_row.id is null then
  if p_expected_version is distinct from 0 or p_status<>'OPEN' or p_next_action is not null then raise exception using errcode='40001',message='followup_version_conflict'; end if;
  insert into public.crm_followups_v2(id,organization_id,lead_id,owner_user_id,title,due_at,source_timezone,created_by)
   values(p_id,p_organization_id,lead_uuid,p_owner_user_id,btrim(p_title),p_due_at,p_source_timezone,auth.uid());
 else
  if old_row.lead_id<>lead_uuid then raise exception 'followup_lead_mismatch'; end if;
  if old_row.version is distinct from p_expected_version then raise exception using errcode='40001',message='followup_version_conflict'; end if;
  if old_row.status<>'OPEN' then raise exception 'followup_already_closed'; end if;
  if p_status<>'OPEN' and char_length(btrim(coalesce(p_outcome,'')))=0 then raise exception 'outcome_required'; end if;
  update public.crm_followups_v2 set title=btrim(p_title),due_at=p_due_at,source_timezone=p_source_timezone,owner_user_id=p_owner_user_id,
   status=p_status,outcome=nullif(btrim(p_outcome),''),version=version+1,updated_at=now(),completed_at=case when p_status='OPEN' then null else now() end
   where organization_id=p_organization_id and id=p_id;
 end if;
 if p_next_action is not null then
  if p_status<>'DONE' or jsonb_typeof(p_next_action)<>'object' or char_length(btrim(coalesce(p_next_action->>'title',''))) not between 1 and 240 then raise exception 'invalid_next_action'; end if;
  next_due=(p_next_action->>'dueAt')::timestamptz;
  if next_due is null or not isfinite(next_due) then raise exception 'invalid_next_action_due'; end if;
  next_id=gen_random_uuid();
  insert into public.crm_followups_v2(id,organization_id,lead_id,owner_user_id,title,due_at,source_timezone,created_by,previous_id)
   values(next_id,p_organization_id,lead_uuid,p_owner_user_id,btrim(p_next_action->>'title'),next_due,p_source_timezone,auth.uid(),p_id);
 end if;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
 values(p_organization_id,auth.uid(),'CRM_FOLLOWUP_SAVED','crm_followup',p_id::text,jsonb_build_object('status',p_status,'nextId',next_id,'commandId',p_command_id));
 if p_status='OPEN' or next_id is not null then
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,title,message,route,entity_type,entity_id,source_key)
   values(p_organization_id,p_owner_user_id,'CRM_FOLLOWUP','Sales follow-up assigned',case when next_id is not null then btrim(p_next_action->>'title') else btrim(p_title) end,'leads','leads',p_legacy_record_id,'crm-followup:'||p_command_id::text) on conflict do nothing;
 end if;
 result_value=public.list_crm_followups_v2(p_organization_id,p_legacy_record_id)||jsonb_build_object('savedId',p_id,'nextId',next_id,'replayed',false);
 insert into public.crm_followup_commands_v2(organization_id,command_id,actor_user_id,request,result) values(p_organization_id,p_command_id,auth.uid(),requested,result_value);
 return result_value;
end; $$;
revoke all on function public.list_crm_followups_v2(uuid,text),public.save_crm_followup_v2(uuid,text,uuid,uuid,integer,text,timestamptz,text,uuid,text,text,jsonb) from public,anon;
grant execute on function public.list_crm_followups_v2(uuid,text),public.save_crm_followup_v2(uuid,text,uuid,uuid,integer,text,timestamptz,text,uuid,text,text,jsonb) to authenticated,service_role;

create or replace function public.list_crm_followup_queue_v2(p_organization_id uuid,p_scope text default 'mine',p_bucket text default 'due',p_timezone text default 'UTC',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result_value jsonb;
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='crm_read_required'; end if;
 if p_scope is null or p_scope not in('mine','team') or p_bucket is null or p_bucket not in('due','overdue','upcoming','all') or p_timezone is null or not exists(select 1 from pg_timezone_names where name=p_timezone) or p_page is null or p_page not between 1 and 100000 then raise exception 'invalid_queue_filter'; end if;
 with scoped as (
  select f.*,l.legacy_record_id,l.display_name lead_name,p.display_name owner_name,
    (f.due_at at time zone p_timezone)::date due_day,(now() at time zone p_timezone)::date today
  from public.crm_followups_v2 f join public.crm_leads l on l.organization_id=f.organization_id and l.id=f.lead_id
   join public.profiles p on p.id=f.owner_user_id
  where f.organization_id=p_organization_id and f.status='OPEN' and l.deleted_at is null and (p_scope='team' or f.owner_user_id=auth.uid())
 ),filtered as (
  select * from scoped where p_bucket='all' or (p_bucket='due' and due_day=today) or (p_bucket='overdue' and due_at<now()) or (p_bucket='upcoming' and due_day>today)
 ),paged as(select * from filtered order by due_at,id limit 25 offset (p_page-1)*25)
 select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(to_jsonb(paged) order by due_at,id) from paged),'[]'::jsonb),
 'total',(select count(*) from filtered),'page',p_page,'pages',greatest(1,ceil((select count(*) from filtered)/25.0)),
 'counts',jsonb_build_object('due',(select count(*) from scoped where due_day=today),'overdue',(select count(*) from scoped where due_at<now()),'upcoming',(select count(*) from scoped where due_day>today),'all',(select count(*) from scoped))) into result_value;
 return result_value;
end; $$;
revoke all on function public.list_crm_followup_queue_v2(uuid,text,text,text,integer) from public,anon;
grant execute on function public.list_crm_followup_queue_v2(uuid,text,text,text,integer) to authenticated,service_role;

-- Called by the authenticated server worker. A unique source key makes retries safe.
create or replace function public.enqueue_due_crm_followups_v2(p_limit integer default 100)
returns integer language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid_batch_size'; end if;
 with due as (
  select f.*,l.legacy_record_id from public.crm_followups_v2 f
  join public.crm_leads l on l.organization_id=f.organization_id and l.id=f.lead_id and l.deleted_at is null
  join public.organization_members m on m.organization_id=f.organization_id and m.user_id=f.owner_user_id and m.status='ACTIVE'
  join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE'
  join public.organizations o on o.id=f.organization_id and o.status='ACTIVE'
  where exists(select 1 from public.organization_roles r join public.role_capabilities rc on rc.role_id=r.id join public.capabilities c on c.id=rc.capability_id where r.id=m.role_id and r.organization_id=m.organization_id and r.key<>'client' and c.key='clients.read')
  and f.status='OPEN' and f.due_at<=now() and not exists(select 1 from public.user_notifications_v2 n where n.organization_id=f.organization_id and n.recipient_user_id=f.owner_user_id and n.source_key='crm-followup-due:'||f.id::text||':'||f.version::text)
  order by f.due_at,f.id limit p_limit for update of f skip locked
 )
 insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
 select organization_id,owner_user_id,'CRM_FOLLOWUP_DUE','WARNING','Sales follow-up is due',title,'leads','leads',legacy_record_id,'crm-followup-due:'||id::text||':'||version::text from due on conflict do nothing;
 get diagnostics affected=row_count;
 return affected;
end; $$;
revoke all on function public.enqueue_due_crm_followups_v2(integer) from public,anon,authenticated;
grant execute on function public.enqueue_due_crm_followups_v2(integer) to service_role;

commit;
