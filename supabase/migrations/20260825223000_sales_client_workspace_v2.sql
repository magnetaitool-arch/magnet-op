-- MAGNET OS V2 / M6: canonical CRM leads and a tenant-safe Client Workspace.
--
-- Legacy records remain the compatibility write model during the staged
-- migration. Additive projections and server-authorized RPCs make the newest
-- UI consistent without deleting, renaming, or silently re-parenting records.

begin;

create table if not exists public.crm_leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null references public.records(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 240),
  company_name text,
  email_normalized text,
  phone text,
  service_interest text,
  message text,
  stage text not null default 'New Lead' check (stage in (
    'New Lead','Contacted','Qualified','Meeting Booked','Meeting Done',
    'Proposal Needed','Proposal Sent','Quotation Sent','Negotiation','Won',
    'Lost','Follow-up Later'
  )),
  source text not null default 'Manual',
  estimated_value numeric(16,2),
  owner_employee_id text,
  submitted_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, legacy_record_id),
  unique (organization_id, id)
);

create index if not exists crm_leads_org_stage_submitted_idx
  on public.crm_leads (organization_id, stage, submitted_at desc)
  where deleted_at is null;
create index if not exists crm_leads_org_name_idx
  on public.crm_leads (organization_id, lower(display_name))
  where deleted_at is null;

create table if not exists public.crm_lead_stage_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  lead_id uuid not null,
  from_stage text,
  to_stage text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  note text,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, lead_id)
    references public.crm_leads(organization_id, id) on delete restrict
);

create index if not exists crm_lead_stage_events_lead_idx
  on public.crm_lead_stage_events (organization_id, lead_id, occurred_at desc);

create table if not exists public.crm_lead_notes (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  lead_id uuid not null,
  note text not null check (char_length(btrim(note)) between 1 and 5000),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, lead_id)
    references public.crm_leads(organization_id, id) on delete restrict
);

create index if not exists crm_lead_notes_lead_idx
  on public.crm_lead_notes (organization_id, lead_id, created_at desc);

create table if not exists public.client_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null references public.records(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 240),
  legal_name text,
  status text not null default 'Onboarding',
  priority text,
  industry text,
  service_type text,
  account_manager_employee_id text,
  project_manager_employee_id text,
  primary_contact_name text,
  primary_contact_email text,
  primary_contact_phone text,
  monthly_retainer numeric(16,2),
  currency text not null default 'EGP',
  profile_data jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  unique (organization_id, legacy_record_id),
  unique (organization_id, id)
);

create index if not exists client_accounts_org_status_name_idx
  on public.client_accounts (organization_id, status, lower(display_name))
  where deleted_at is null;

create or replace function public.normalize_crm_lead_stage(p_stage text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(btrim(coalesce(p_stage, '')))
    when 'new' then 'New Lead'
    when 'new lead' then 'New Lead'
    when 'contacted' then 'Contacted'
    when 'qualified' then 'Qualified'
    when 'meeting booked' then 'Meeting Booked'
    when 'meeting done' then 'Meeting Done'
    when 'proposal needed' then 'Proposal Needed'
    when 'proposal sent' then 'Proposal Sent'
    when 'quotation sent' then 'Quotation Sent'
    when 'negotiation' then 'Negotiation'
    when 'won' then 'Won'
    when 'lost' then 'Lost'
    when 'follow-up later' then 'Follow-up Later'
    when 'follow up later' then 'Follow-up Later'
    else 'New Lead'
  end;
$$;

create or replace function public.sync_sales_client_v2_from_legacy_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_data jsonb := coalesce(new.data, '{}'::jsonb);
  numeric_value numeric;
  retainer_value numeric;
  service_value text;
begin
  if new.coll = 'leads' then
    if new.deleted_at is not null or lower(coalesce(record_data->>'_del', 'false')) = 'true' then
      update public.crm_leads
      set deleted_at = coalesce(new.deleted_at, now()), updated_at = now(), version = version + 1
      where organization_id = new.organization_id and legacy_record_id = new.id and deleted_at is null;
      return new;
    end if;
    if coalesce(record_data->>'value', '') ~ '^-?[0-9]+([.][0-9]+)?$' then
      numeric_value := (record_data->>'value')::numeric;
    end if;
    service_value := case
      when jsonb_typeof(record_data->'serviceInterest') = 'array'
        then array_to_string(array(select jsonb_array_elements_text(record_data->'serviceInterest')), ', ')
      else nullif(btrim(record_data->>'serviceInterest'), '')
    end;
    insert into public.crm_leads (
      organization_id, legacy_record_id, display_name, company_name,
      email_normalized, phone, service_interest, message, stage, source,
      estimated_value, owner_employee_id, submitted_at, payload
    ) values (
      new.organization_id,
      new.id,
      coalesce(nullif(btrim(record_data->>'name'), ''), nullif(btrim(record_data->>'company'), ''), 'Unnamed lead'),
      nullif(btrim(record_data->>'company'), ''),
      lower(nullif(btrim(record_data->>'email'), '')),
      nullif(btrim(record_data->>'phone'), ''),
      service_value,
      coalesce(nullif(btrim(record_data->>'message'), ''), nullif(btrim(record_data->>'notes'), '')),
      public.normalize_crm_lead_stage(record_data->>'status'),
      coalesce(nullif(btrim(record_data->>'source'), ''), 'Manual'),
      numeric_value,
      nullif(btrim(record_data->>'ownerId'), ''),
      coalesce(new.created_at, now()),
      record_data
    )
    on conflict (organization_id, legacy_record_id) do update
    set display_name = excluded.display_name,
        company_name = excluded.company_name,
        email_normalized = excluded.email_normalized,
        phone = excluded.phone,
        service_interest = excluded.service_interest,
        message = excluded.message,
        stage = excluded.stage,
        source = excluded.source,
        estimated_value = excluded.estimated_value,
        owner_employee_id = excluded.owner_employee_id,
        payload = excluded.payload,
        deleted_at = null,
        updated_at = now(),
        version = public.crm_leads.version + 1;
    return new;
  end if;

  if new.coll = 'clients' then
    if new.deleted_at is not null or lower(coalesce(record_data->>'_del', 'false')) = 'true' then
      update public.client_accounts
      set deleted_at = coalesce(new.deleted_at, now()), archived_at = coalesce(archived_at, now()),
          updated_at = now(), version = version + 1
      where organization_id = new.organization_id and legacy_record_id = new.id and deleted_at is null;
      return new;
    end if;
    if coalesce(record_data->>'monthlyRetainer', '') ~ '^-?[0-9]+([.][0-9]+)?$' then
      retainer_value := (record_data->>'monthlyRetainer')::numeric;
    end if;
    insert into public.client_accounts (
      organization_id, legacy_record_id, display_name, legal_name, status,
      priority, industry, service_type, account_manager_employee_id,
      project_manager_employee_id, primary_contact_name, primary_contact_email,
      primary_contact_phone, monthly_retainer, currency, profile_data,
      archived_at, deleted_at
    ) values (
      new.organization_id,
      new.id,
      coalesce(nullif(btrim(record_data->>'brandName'), ''), nullif(btrim(record_data->>'name'), ''), 'Unnamed client'),
      nullif(btrim(record_data->>'legalName'), ''),
      coalesce(nullif(btrim(record_data->>'status'), ''), 'Onboarding'),
      nullif(btrim(record_data->>'priority'), ''),
      nullif(btrim(record_data->>'industry'), ''),
      coalesce(nullif(btrim(record_data->>'serviceType'), ''), nullif(btrim(record_data->>'services'), '')),
      nullif(btrim(record_data->>'accountManagerId'), ''),
      nullif(btrim(record_data->>'projectManagerId'), ''),
      nullif(btrim(record_data->>'mainContactName'), ''),
      lower(nullif(btrim(record_data->>'mainContactEmail'), '')),
      coalesce(nullif(btrim(record_data->>'mainContactPhone'), ''), nullif(btrim(record_data->>'mainContactWhatsapp'), '')),
      retainer_value,
      coalesce(nullif(upper(btrim(record_data->>'currency')), ''), 'EGP'),
      record_data,
      case when coalesce(record_data->>'status', '') in ('Archived','Churned') then now() else null end,
      null
    )
    on conflict (organization_id, legacy_record_id) do update
    set display_name = excluded.display_name,
        legal_name = excluded.legal_name,
        status = excluded.status,
        priority = excluded.priority,
        industry = excluded.industry,
        service_type = excluded.service_type,
        account_manager_employee_id = excluded.account_manager_employee_id,
        project_manager_employee_id = excluded.project_manager_employee_id,
        primary_contact_name = excluded.primary_contact_name,
        primary_contact_email = excluded.primary_contact_email,
        primary_contact_phone = excluded.primary_contact_phone,
        monthly_retainer = excluded.monthly_retainer,
        currency = excluded.currency,
        profile_data = excluded.profile_data,
        archived_at = excluded.archived_at,
        deleted_at = null,
        updated_at = now(),
        version = public.client_accounts.version + 1;
  end if;
  return new;
end;
$$;

create or replace function public.log_crm_lead_stage_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.crm_lead_stage_events (
      organization_id, lead_id, from_stage, to_stage, actor_user_id, note
    ) values (new.organization_id, new.id, null, new.stage, auth.uid(), 'Lead profile created');
  elsif new.stage is distinct from old.stage then
    insert into public.crm_lead_stage_events (
      organization_id, lead_id, from_stage, to_stage, actor_user_id
    ) values (new.organization_id, new.id, old.stage, new.stage, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists records_sync_sales_client_v2 on public.records;
create trigger records_sync_sales_client_v2
  after insert or update on public.records
  for each row execute function public.sync_sales_client_v2_from_legacy_record();

drop trigger if exists crm_leads_stage_event on public.crm_leads;
create trigger crm_leads_stage_event
  after insert or update of stage on public.crm_leads
  for each row execute function public.log_crm_lead_stage_event();

drop trigger if exists crm_leads_set_updated_at on public.crm_leads;
create trigger crm_leads_set_updated_at before update on public.crm_leads
  for each row execute function public.set_saas_updated_at();
drop trigger if exists client_accounts_set_updated_at on public.client_accounts;
create trigger client_accounts_set_updated_at before update on public.client_accounts
  for each row execute function public.set_saas_updated_at();

drop trigger if exists crm_lead_stage_events_append_only on public.crm_lead_stage_events;
create trigger crm_lead_stage_events_append_only
  before update or delete on public.crm_lead_stage_events
  for each row execute function public.prevent_event_mutation();
drop trigger if exists crm_lead_notes_append_only on public.crm_lead_notes;
create trigger crm_lead_notes_append_only
  before update or delete on public.crm_lead_notes
  for each row execute function public.prevent_event_mutation();

-- Backfill through the same trigger function so future and historical records
-- use one projection rule. The harmless data assignment fires UPDATE triggers.
update public.records set data = data
where coll in ('leads','clients') and deleted_at is null
  and lower(coalesce(data->>'_del', 'false')) <> 'true';

do $$
declare
  legacy_leads integer;
  canonical_leads integer;
  legacy_clients integer;
  canonical_clients integer;
begin
  select count(*) into legacy_leads from public.records
    where coll = 'leads' and deleted_at is null and lower(coalesce(data->>'_del', 'false')) <> 'true';
  select count(*) into canonical_leads from public.crm_leads where deleted_at is null;
  select count(*) into legacy_clients from public.records
    where coll = 'clients' and deleted_at is null and lower(coalesce(data->>'_del', 'false')) <> 'true';
  select count(*) into canonical_clients from public.client_accounts where deleted_at is null;
  if legacy_leads <> canonical_leads or legacy_clients <> canonical_clients then
    raise exception 'M6 projection mismatch: leads %/%, clients %/%',
      legacy_leads, canonical_leads, legacy_clients, canonical_clients;
  end if;
end $$;

create or replace function public.can_access_client_workspace(
  p_organization_id uuid,
  p_legacy_client_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  role_key text;
  profile_client_id text;
begin
  if not public.has_org_capability(p_organization_id, 'clients.read') then return false; end if;
  role_key := public.current_member_role_key(p_organization_id);
  if role_key <> 'client' then return true; end if;
  select nullif(profile.client_id, '') into profile_client_id
  from public.profiles profile where profile.id = auth.uid();
  return profile_client_id is not null and profile_client_id = p_legacy_client_id;
end;
$$;

alter table public.crm_leads enable row level security;
alter table public.crm_lead_stage_events enable row level security;
alter table public.crm_lead_notes enable row level security;
alter table public.client_accounts enable row level security;

revoke all privileges on public.crm_leads, public.crm_lead_stage_events,
  public.crm_lead_notes, public.client_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.crm_leads, public.crm_lead_stage_events,
  public.crm_lead_notes, public.client_accounts to service_role;
grant usage, select on sequence public.crm_lead_stage_events_id_seq,
  public.crm_lead_notes_id_seq to service_role;

create policy crm_leads_member_read on public.crm_leads
  for select to authenticated
  using (deleted_at is null and public.has_org_capability(organization_id, 'clients.read')
    and public.current_member_role_key(organization_id) <> 'client');
create policy crm_lead_stage_events_member_read on public.crm_lead_stage_events
  for select to authenticated
  using (public.has_org_capability(organization_id, 'clients.read')
    and public.current_member_role_key(organization_id) <> 'client');
create policy crm_lead_notes_member_read on public.crm_lead_notes
  for select to authenticated
  using (public.has_org_capability(organization_id, 'clients.read')
    and public.current_member_role_key(organization_id) <> 'client');
create policy client_accounts_member_read on public.client_accounts
  for select to authenticated
  using (deleted_at is null and public.can_access_client_workspace(organization_id, legacy_record_id));

grant select on public.crm_leads, public.crm_lead_stage_events,
  public.crm_lead_notes, public.client_accounts to authenticated;

create or replace function public.list_crm_leads(
  p_organization_id uuid,
  p_stage text default null,
  p_search text default null,
  p_source text default null,
  p_sort text default 'submitted_desc',
  p_page integer default 1,
  p_page_size integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_stage text := nullif(btrim(coalesce(p_stage, '')), '');
  normalized_search text := left(btrim(coalesce(p_search, '')), 120);
  normalized_source text := left(btrim(coalesce(p_source, '')), 80);
  normalized_sort text := lower(btrim(coalesce(p_sort, 'submitted_desc')));
  page_number integer := greatest(1, coalesce(p_page, 1));
  page_size integer := greatest(1, least(coalesce(p_page_size, 24), 100));
  total_rows integer;
  stage_counts jsonb;
  page_items jsonb;
begin
  if not public.has_org_capability(p_organization_id, 'clients.read')
     or public.current_member_role_key(p_organization_id) = 'client' then
    raise exception using errcode = '42501', message = 'crm_read_required';
  end if;
  if normalized_stage is not null and public.normalize_crm_lead_stage(normalized_stage) <> normalized_stage then
    raise exception using errcode = 'P0001', message = 'invalid_lead_stage';
  end if;
  if normalized_sort not in ('submitted_desc','submitted_asc','name_asc','value_desc') then
    normalized_sort := 'submitted_desc';
  end if;

  select jsonb_object_agg(stage_name, stage_count order by stage_order) into stage_counts
  from (
    select stages.stage_name, stages.stage_order, count(lead.id)::integer stage_count
    from (values
      ('New Lead',1),('Contacted',2),('Qualified',3),('Meeting Booked',4),
      ('Meeting Done',5),('Proposal Needed',6),('Proposal Sent',7),
      ('Quotation Sent',8),('Negotiation',9),('Won',10),('Lost',11),
      ('Follow-up Later',12)
    ) stages(stage_name, stage_order)
    left join public.crm_leads lead on lead.organization_id = p_organization_id
      and lead.stage = stages.stage_name and lead.deleted_at is null
    group by stages.stage_name, stages.stage_order
  ) counts;

  select count(*)::integer into total_rows
  from public.crm_leads lead
  where lead.organization_id = p_organization_id and lead.deleted_at is null
    and (normalized_stage is null or lead.stage = normalized_stage)
    and (normalized_source = '' or lead.source = normalized_source)
    and (normalized_search = '' or concat_ws(' ', lead.display_name, lead.company_name,
      lead.email_normalized, lead.phone, lead.service_interest) ilike '%' || normalized_search || '%');

  select coalesce(jsonb_agg(item order by item_order), '[]'::jsonb) into page_items
  from (
    select jsonb_build_object(
      'id', lead.id, 'legacyRecordId', lead.legacy_record_id,
      'name', lead.display_name, 'company', lead.company_name,
      'email', lead.email_normalized, 'phone', lead.phone,
      'serviceInterest', lead.service_interest, 'message', lead.message,
      'stage', lead.stage, 'source', lead.source,
      'value', lead.estimated_value, 'ownerId', lead.owner_employee_id,
      'submittedAt', lead.submitted_at, 'version', lead.version
    ) item,
    row_number() over (order by
      case when normalized_sort = 'name_asc' then lower(lead.display_name) end asc,
      case when normalized_sort = 'value_desc' then lead.estimated_value end desc nulls last,
      case when normalized_sort = 'submitted_asc' then lead.submitted_at end asc,
      case when normalized_sort = 'submitted_desc' then lead.submitted_at end desc,
      lead.id
    ) item_order
    from public.crm_leads lead
    where lead.organization_id = p_organization_id and lead.deleted_at is null
      and (normalized_stage is null or lead.stage = normalized_stage)
      and (normalized_source = '' or lead.source = normalized_source)
      and (normalized_search = '' or concat_ws(' ', lead.display_name, lead.company_name,
        lead.email_normalized, lead.phone, lead.service_interest) ilike '%' || normalized_search || '%')
    order by
      case when normalized_sort = 'name_asc' then lower(lead.display_name) end asc,
      case when normalized_sort = 'value_desc' then lead.estimated_value end desc nulls last,
      case when normalized_sort = 'submitted_asc' then lead.submitted_at end asc,
      case when normalized_sort = 'submitted_desc' then lead.submitted_at end desc,
      lead.id
    limit page_size offset (page_number - 1) * page_size
  ) page;

  return jsonb_build_object('ok', true, 'items', page_items,
    'counts', coalesce(stage_counts, '{}'::jsonb), 'total', total_rows,
    'page', page_number, 'pageSize', page_size,
    'pages', greatest(1, ceil(total_rows::numeric / page_size)::integer));
end;
$$;

create or replace function public.get_crm_lead_profile(
  p_organization_id uuid,
  p_legacy_record_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare lead_row public.crm_leads%rowtype;
begin
  if not public.has_org_capability(p_organization_id, 'clients.read')
     or public.current_member_role_key(p_organization_id) = 'client' then
    raise exception using errcode = '42501', message = 'crm_read_required';
  end if;
  select * into lead_row from public.crm_leads lead
  where lead.organization_id = p_organization_id
    and lead.legacy_record_id = p_legacy_record_id and lead.deleted_at is null;
  if lead_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object(
    'ok', true,
    'lead', jsonb_build_object(
      'id', lead_row.id, 'legacyRecordId', lead_row.legacy_record_id,
      'name', lead_row.display_name, 'company', lead_row.company_name,
      'email', lead_row.email_normalized, 'phone', lead_row.phone,
      'serviceInterest', lead_row.service_interest, 'message', lead_row.message,
      'stage', lead_row.stage, 'source', lead_row.source,
      'value', lead_row.estimated_value, 'ownerId', lead_row.owner_employee_id,
      'submittedAt', lead_row.submitted_at, 'payload', lead_row.payload,
      'version', lead_row.version
    ),
    'notes', coalesce((select jsonb_agg(jsonb_build_object(
      'id', note.id, 'note', note.note, 'createdBy', note.created_by,
      'createdAt', note.created_at) order by note.created_at desc)
      from public.crm_lead_notes note where note.organization_id = p_organization_id
        and note.lead_id = lead_row.id), '[]'::jsonb),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'id', event.id, 'fromStage', event.from_stage, 'toStage', event.to_stage,
      'actorUserId', event.actor_user_id, 'note', event.note,
      'occurredAt', event.occurred_at) order by event.occurred_at desc)
      from public.crm_lead_stage_events event where event.organization_id = p_organization_id
        and event.lead_id = lead_row.id), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'proposals' and record.deleted_at is null
        and record.data->>'leadId' = p_legacy_record_id), '[]'::jsonb),
    'quotations', coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'quotations' and record.deleted_at is null
        and record.data->>'leadId' = p_legacy_record_id), '[]'::jsonb),
    'activities', coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'salesActivities' and record.deleted_at is null
        and record.data->>'leadId' = p_legacy_record_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.change_crm_lead_stage(
  p_organization_id uuid,
  p_legacy_record_id text,
  p_stage text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_stage text := public.normalize_crm_lead_stage(p_stage);
  lead_id_value uuid;
begin
  if not public.has_org_capability(p_organization_id, 'clients.manage') then
    raise exception using errcode = '42501', message = 'crm_manage_required';
  end if;
  if p_stage is null or normalized_stage <> btrim(p_stage) then
    raise exception using errcode = 'P0001', message = 'invalid_lead_stage';
  end if;
  update public.records record
  set data = jsonb_set(jsonb_set(record.data, '{status}', to_jsonb(normalized_stage), true),
      '{updatedAt}', to_jsonb(now()), true), updated_at = now()
  where record.organization_id = p_organization_id and record.id = p_legacy_record_id
    and record.coll = 'leads' and record.deleted_at is null;
  if not found then raise exception using errcode = 'P0001', message = 'lead_not_found'; end if;
  select lead.id into lead_id_value from public.crm_leads lead
  where lead.organization_id = p_organization_id and lead.legacy_record_id = p_legacy_record_id;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into public.crm_lead_notes (organization_id, lead_id, note, created_by)
    values (p_organization_id, lead_id_value, left(btrim(p_note), 5000), auth.uid());
  end if;
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_context)
  values (p_organization_id, auth.uid(), 'CRM_LEAD_STAGE_CHANGED', 'crm_lead', lead_id_value::text,
    jsonb_build_object('legacyRecordId', p_legacy_record_id, 'stage', normalized_stage));
  return public.get_crm_lead_profile(p_organization_id, p_legacy_record_id);
end;
$$;

create or replace function public.add_crm_lead_note(
  p_organization_id uuid,
  p_legacy_record_id text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare lead_id_value uuid;
begin
  if not public.has_org_capability(p_organization_id, 'clients.manage') then
    raise exception using errcode = '42501', message = 'crm_manage_required';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) not between 1 and 5000 then
    raise exception using errcode = 'P0001', message = 'invalid_lead_note';
  end if;
  select lead.id into lead_id_value from public.crm_leads lead
  where lead.organization_id = p_organization_id and lead.legacy_record_id = p_legacy_record_id
    and lead.deleted_at is null;
  if lead_id_value is null then raise exception using errcode = 'P0001', message = 'lead_not_found'; end if;
  insert into public.crm_lead_notes (organization_id, lead_id, note, created_by)
  values (p_organization_id, lead_id_value, btrim(p_note), auth.uid());
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_context)
  values (p_organization_id, auth.uid(), 'CRM_LEAD_NOTE_ADDED', 'crm_lead', lead_id_value::text,
    jsonb_build_object('legacyRecordId', p_legacy_record_id));
  return public.get_crm_lead_profile(p_organization_id, p_legacy_record_id);
end;
$$;

create or replace function public.list_client_workspaces(
  p_organization_id uuid,
  p_status text default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_status text := nullif(btrim(coalesce(p_status, '')), '');
  normalized_search text := left(btrim(coalesce(p_search, '')), 120);
  page_number integer := greatest(1, coalesce(p_page, 1));
  page_size integer := greatest(1, least(coalesce(p_page_size, 25), 100));
  total_rows integer;
  can_finance boolean := public.has_org_capability(p_organization_id, 'finance.read');
  page_items jsonb;
begin
  if not public.has_org_capability(p_organization_id, 'clients.read') then
    raise exception using errcode = '42501', message = 'clients_read_required';
  end if;
  select count(*)::integer into total_rows
  from public.client_accounts client
  where client.organization_id = p_organization_id and client.deleted_at is null
    and public.can_access_client_workspace(p_organization_id, client.legacy_record_id)
    and (normalized_status is null or client.status = normalized_status)
    and (normalized_search = '' or concat_ws(' ', client.display_name, client.legal_name,
      client.primary_contact_name, client.primary_contact_email, client.primary_contact_phone,
      client.industry, client.service_type) ilike '%' || normalized_search || '%');

  select coalesce(jsonb_agg(item order by item_order), '[]'::jsonb) into page_items
  from (
    select jsonb_build_object(
      'id', client.id, 'legacyRecordId', client.legacy_record_id,
      'name', client.display_name, 'legalName', client.legal_name,
      'status', client.status, 'priority', client.priority,
      'industry', client.industry, 'serviceType', client.service_type,
      'accountManagerId', client.account_manager_employee_id,
      'projectManagerId', client.project_manager_employee_id,
      'primaryContactName', client.primary_contact_name,
      'primaryContactEmail', client.primary_contact_email,
      'primaryContactPhone', client.primary_contact_phone,
      'monthlyRetainer', case when can_finance then client.monthly_retainer else null end,
      'currency', client.currency,
      'activeProjects', (select count(*)::integer from public.records record
        where record.organization_id = p_organization_id and record.coll = 'projects'
          and record.deleted_at is null and record.data->>'clientId' = client.legacy_record_id
          and coalesce(record.data->>'status', '') not in ('Completed','Archived','Cancelled')),
      'projectStatus', (select record.data->>'status' from public.records record
        where record.organization_id = p_organization_id and record.coll = 'projects'
          and record.deleted_at is null and record.data->>'clientId' = client.legacy_record_id
          and coalesce(record.data->>'status', '') not in ('Completed','Archived','Cancelled')
        order by record.updated_at desc limit 1),
      'activeContract', (select jsonb_build_object('id', record.id,
          'number', record.data->>'contractNumber', 'status', record.data->>'status',
          'type', record.data->>'contractType', 'endDate', record.data->>'endDate')
        from public.records record where record.organization_id = p_organization_id
          and record.coll = 'contracts' and record.deleted_at is null
          and record.data->>'clientId' = client.legacy_record_id
          and coalesce(record.data->>'status', '') in ('Signed','Active')
        order by record.updated_at desc limit 1),
      'currentBalance', case when can_finance then
        coalesce((select sum(case when coalesce(record.data->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$'
          then (record.data->>'amount')::numeric else 0 end)
          from public.records record where record.organization_id = p_organization_id
            and record.coll = 'invoices' and record.deleted_at is null
            and record.data->>'clientId' = client.legacy_record_id
            and coalesce(record.data->>'status','') not in ('Draft','Cancelled')), 0)
        - coalesce((select sum(case when coalesce(record.data->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$'
          then (record.data->>'amount')::numeric else 0 end)
          from public.records record where record.organization_id = p_organization_id
            and record.coll = 'payments' and record.deleted_at is null
            and record.data->>'clientId' = client.legacy_record_id), 0)
        else null end,
      'version', client.version
    ) item,
    row_number() over (order by lower(client.display_name), client.id) item_order
    from public.client_accounts client
    where client.organization_id = p_organization_id and client.deleted_at is null
      and public.can_access_client_workspace(p_organization_id, client.legacy_record_id)
      and (normalized_status is null or client.status = normalized_status)
      and (normalized_search = '' or concat_ws(' ', client.display_name, client.legal_name,
        client.primary_contact_name, client.primary_contact_email, client.primary_contact_phone,
        client.industry, client.service_type) ilike '%' || normalized_search || '%')
    order by lower(client.display_name), client.id
    limit page_size offset (page_number - 1) * page_size
  ) page;
  return jsonb_build_object('ok', true, 'items', page_items, 'total', total_rows,
    'page', page_number, 'pageSize', page_size,
    'pages', greatest(1, ceil(total_rows::numeric / page_size)::integer));
end;
$$;

create or replace function public.get_client_workspace(
  p_organization_id uuid,
  p_legacy_client_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  client_row public.client_accounts%rowtype;
  can_work boolean := public.has_org_capability(p_organization_id, 'work.read');
  can_finance boolean := public.has_org_capability(p_organization_id, 'finance.read');
  can_reports boolean := public.has_org_capability(p_organization_id, 'reports.read');
  can_audit boolean := public.has_org_capability(p_organization_id, 'audit.read');
  current_balance numeric;
begin
  if not public.can_access_client_workspace(p_organization_id, p_legacy_client_id) then
    raise exception using errcode = '42501', message = 'client_workspace_access_required';
  end if;
  select * into client_row from public.client_accounts client
  where client.organization_id = p_organization_id
    and client.legacy_record_id = p_legacy_client_id and client.deleted_at is null;
  if client_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if can_finance then
    select coalesce(sum(case when coalesce(record.data->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$'
      then (record.data->>'amount')::numeric else 0 end), 0) into current_balance
    from public.records record where record.organization_id = p_organization_id
      and record.coll = 'invoices' and record.deleted_at is null
      and record.data->>'clientId' = p_legacy_client_id
      and coalesce(record.data->>'status','') not in ('Draft','Cancelled');
    current_balance := current_balance - coalesce((select sum(case
      when coalesce(record.data->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$'
      then (record.data->>'amount')::numeric else 0 end)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'payments' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), 0);
  end if;

  return jsonb_build_object(
    'ok', true,
    'client', jsonb_build_object(
      'id', client_row.id, 'legacyRecordId', client_row.legacy_record_id,
      'name', client_row.display_name, 'legalName', client_row.legal_name,
      'status', client_row.status, 'priority', client_row.priority,
      'industry', client_row.industry, 'serviceType', client_row.service_type,
      'accountManagerId', client_row.account_manager_employee_id,
      'projectManagerId', client_row.project_manager_employee_id,
      'primaryContactName', client_row.primary_contact_name,
      'primaryContactEmail', client_row.primary_contact_email,
      'primaryContactPhone', client_row.primary_contact_phone,
      'monthlyRetainer', case when can_finance then client_row.monthly_retainer else null end,
      'currency', client_row.currency, 'profile', client_row.profile_data,
      'currentBalance', case when can_finance then current_balance else null end,
      'version', client_row.version
    ),
    'contacts', coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'contacts' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb),
    'projects', case when can_work then coalesce((select jsonb_agg(record.data order by record.updated_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'projects' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
    'tasks', case when can_work then coalesce((select jsonb_agg(record.data order by record.updated_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'tasks' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
    'contracts', coalesce((select jsonb_agg(record.data order by record.updated_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'contracts' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb),
    'invoices', case when can_finance then coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'invoices' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
    'payments', case when can_finance then coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'payments' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
    'files', case when can_work then coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll in ('files','clientAssets') and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
    'communication', jsonb_build_object(
      'meetings', case when can_work then coalesce((select jsonb_agg(record.data order by record.created_at desc)
        from public.records record where record.organization_id = p_organization_id
          and record.coll = 'meetings' and record.deleted_at is null
          and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
      'messages', case when can_work then coalesce((select jsonb_agg(record.data order by record.created_at desc)
        from public.records record where record.organization_id = p_organization_id
          and record.coll = 'chatMessages' and record.deleted_at is null
          and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
      'comments', case when can_work then coalesce((select jsonb_agg(record.data order by record.created_at desc)
        from public.records record where record.organization_id = p_organization_id
          and record.coll = 'comments' and record.deleted_at is null
          and record.data->>'entityType' = 'clients'
          and record.data->>'entityId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end
    ),
    'reports', case when can_reports then coalesce((select jsonb_agg(record.data order by record.created_at desc)
      from public.records record where record.organization_id = p_organization_id
        and record.coll = 'reports' and record.deleted_at is null
        and record.data->>'clientId' = p_legacy_client_id), '[]'::jsonb) else '[]'::jsonb end,
    'activity', case when can_audit then coalesce((select jsonb_agg(jsonb_build_object(
      'id', event.id, 'action', event.action, 'entityType', event.entity_type,
      'entityId', event.entity_id, 'actorUserId', event.actor_user_id,
      'occurredAt', event.occurred_at, 'context', event.safe_context)
      order by event.occurred_at desc) from public.audit_events event
      where event.organization_id = p_organization_id
        and ((event.entity_type in ('client','client_account') and event.entity_id in (client_row.id::text, p_legacy_client_id))
          or event.safe_context->>'clientId' = p_legacy_client_id)), '[]'::jsonb) else '[]'::jsonb end,
    'activeContract', (select record.data from public.records record
      where record.organization_id = p_organization_id and record.coll = 'contracts'
        and record.deleted_at is null and record.data->>'clientId' = p_legacy_client_id
        and coalesce(record.data->>'status','') in ('Signed','Active')
      order by record.updated_at desc limit 1),
    'projectStatus', (select record.data->>'status' from public.records record
      where record.organization_id = p_organization_id and record.coll = 'projects'
        and record.deleted_at is null and record.data->>'clientId' = p_legacy_client_id
        and coalesce(record.data->>'status','') not in ('Completed','Archived','Cancelled')
      order by record.updated_at desc limit 1)
  );
end;
$$;

revoke all on function public.normalize_crm_lead_stage(text) from public, anon;
revoke all on function public.sync_sales_client_v2_from_legacy_record() from public, anon, authenticated;
revoke all on function public.log_crm_lead_stage_event() from public, anon, authenticated;
revoke all on function public.can_access_client_workspace(uuid,text) from public, anon;
revoke all on function public.list_crm_leads(uuid,text,text,text,text,integer,integer) from public, anon;
revoke all on function public.get_crm_lead_profile(uuid,text) from public, anon;
revoke all on function public.change_crm_lead_stage(uuid,text,text,text) from public, anon;
revoke all on function public.add_crm_lead_note(uuid,text,text) from public, anon;
revoke all on function public.list_client_workspaces(uuid,text,text,integer,integer) from public, anon;
revoke all on function public.get_client_workspace(uuid,text) from public, anon;

grant execute on function public.normalize_crm_lead_stage(text) to authenticated, service_role;
grant execute on function public.can_access_client_workspace(uuid,text) to authenticated, service_role;
grant execute on function public.list_crm_leads(uuid,text,text,text,text,integer,integer) to authenticated, service_role;
grant execute on function public.get_crm_lead_profile(uuid,text) to authenticated, service_role;
grant execute on function public.change_crm_lead_stage(uuid,text,text,text) to authenticated, service_role;
grant execute on function public.add_crm_lead_note(uuid,text,text) to authenticated, service_role;
grant execute on function public.list_client_workspaces(uuid,text,text,integer,integer) to authenticated, service_role;
grant execute on function public.get_client_workspace(uuid,text) to authenticated, service_role;

insert into public.migration_audit (migration, note)
values (
  '20260825223000_sales_client_workspace_v2',
  'Projected legacy leads and clients into canonical tenant-scoped roots, added immutable CRM history/notes, server-authorized pipeline commands, and one capability-aware Client Workspace aggregation without deleting legacy records.'
);

commit;

-- Rollback is forward-only: revert the UI feature flag and revoke the M6 RPCs.
-- Keep canonical projections, notes, stage history, and audit evidence intact.
