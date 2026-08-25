-- MAGNET OS V2 / M8: tenant-safe contract lifecycle, templates, and public review.
--
-- Legacy records remain the compatibility write model. Canonical contract rows,
-- server-authorized lifecycle commands, hashed expiring review links, and an
-- append-only status timeline make contracts safe to operate during migration.

begin;

create or replace function public.normalize_contract_v2_status(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(btrim(coalesce(p_status, '')))
    when 'draft' then 'Draft'
    when 'pending internal approval' then 'Internal Review'
    when 'internal review' then 'Internal Review'
    when 'approved internally' then 'Ready'
    when 'ready' then 'Ready'
    when 'sent' then 'Sent'
    when 'signed' then 'Signed'
    when 'active' then 'Active'
    when 'expired' then 'Expired'
    when 'cancelled' then 'Cancelled'
    when 'canceled' then 'Cancelled'
    else 'Draft'
  end;
$$;

create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete restrict,
  template_key text not null check (template_key ~ '^[a-z0-9_]{3,80}$'),
  name text not null check (char_length(btrim(name)) between 3 and 160),
  service_type text not null,
  language text not null default 'en' check (language in ('en','ar','bilingual')),
  default_sections jsonb not null default '{}'::jsonb check (jsonb_typeof(default_sections) = 'object'),
  default_terms jsonb not null default '{}'::jsonb check (jsonb_typeof(default_terms) = 'object'),
  is_system boolean not null default false,
  is_active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists contract_templates_scope_key_uq
  on public.contract_templates (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), template_key)
  where deleted_at is null;

create table if not exists public.agency_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null references public.records(id) on delete restrict,
  client_account_id uuid not null,
  legacy_client_id text not null,
  legacy_project_id text,
  template_key text not null default 'retainer',
  contract_number text not null,
  contract_type text not null default 'Retainer',
  status text not null default 'Draft' check (status in (
    'Draft','Internal Review','Ready','Sent','Signed','Active','Expired','Cancelled'
  )),
  start_date date,
  end_date date,
  currency text not null default 'EGP' check (char_length(currency) between 3 and 8),
  contract_value numeric(16,2) not null default 0 check (contract_value >= 0),
  payment_terms text,
  scope_summary text,
  sections jsonb not null default '{}'::jsonb check (jsonb_typeof(sections) = 'object'),
  payload jsonb not null default '{}'::jsonb,
  signed_at timestamptz,
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (organization_id, client_account_id)
    references public.client_accounts(organization_id, id) on delete restrict,
  unique (organization_id, legacy_record_id),
  unique (organization_id, id),
  unique (organization_id, contract_number)
);

create index if not exists agency_contracts_org_status_dates_idx
  on public.agency_contracts (organization_id, status, end_date, updated_at desc)
  where deleted_at is null and archived_at is null;
create index if not exists agency_contracts_client_idx
  on public.agency_contracts (organization_id, client_account_id, updated_at desc)
  where deleted_at is null and archived_at is null;

create table if not exists public.contract_status_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  contract_id uuid not null,
  from_status text,
  to_status text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  note text,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, contract_id)
    references public.agency_contracts(organization_id, id) on delete restrict
);

create index if not exists contract_status_events_contract_idx
  on public.contract_status_events (organization_id, contract_id, occurred_at desc);

create table if not exists public.contract_access_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contract_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  purpose text not null default 'REVIEW_AND_SIGN' check (purpose in ('REVIEW','REVIEW_AND_SIGN')),
  state text not null default 'ACTIVE' check (state in ('ACTIVE','ACCEPTED','REVOKED','EXPIRED')),
  expires_at timestamptz not null,
  max_uses integer not null default 25 check (max_uses between 1 and 100),
  use_count integer not null default 0 check (use_count >= 0),
  last_accessed_at timestamptz,
  accepted_at timestamptz,
  signer_name text,
  signer_email_normalized text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, contract_id)
    references public.agency_contracts(organization_id, id) on delete restrict
);

create index if not exists contract_access_links_active_idx
  on public.contract_access_links (organization_id, contract_id, expires_at desc)
  where state = 'ACTIVE';

create table if not exists public.contract_projection_issues (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null,
  issue_code text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (organization_id, legacy_record_id, issue_code)
);

insert into public.contract_templates (
  organization_id, template_key, name, service_type, language,
  default_sections, default_terms, is_system
)
select null, seed.template_key, seed.name, seed.service_type, 'bilingual',
  jsonb_build_object(
    'definitions', 'Services, deliverables, platforms and written approvals are defined by this agreement and its approved schedules.',
    'scope', seed.scope_text,
    'kpis', 'KPIs are measurement indicators and do not constitute a guarantee of commercial results unless expressly stated.',
    'deliverables', seed.deliverables_text,
    'latePaymentPolicy', 'Overdue amounts may pause delivery timelines after written notice. Work resumes after cleared payment.',
    'agencyResponsibilities', 'The Agency will perform the agreed services professionally, protect access credentials, and report material blockers.',
    'clientResponsibilities', 'The Client will provide approvals, assets, access, and accurate information within the agreed response times.',
    'workingHours', 'Official working hours and emergency escalation channels follow the active account plan and written onboarding record.',
    'outOfScope', 'Requests outside the approved scope require a written change request, revised timeline, and additional fee approval.',
    'exclusions', 'Any service, deliverable, media spend, license, production cost or third-party fee not expressly listed is excluded.',
    'intellectualProperty', 'Final approved deliverables transfer after full payment, excluding licensed third-party assets and Agency tools.',
    'confidentiality', 'Both parties will protect confidential information and use it only to perform this agreement.',
    'portfolioUsage', 'The Agency may display public final work in its portfolio unless the Client opts out in additional conditions.',
    'liability', 'Each party remains responsible for its own unlawful acts. Indirect and consequential damages are excluded to the extent permitted by law.',
    'forceMajeure', 'Neither party is liable for delays caused by events beyond reasonable control, provided prompt notice is given.',
    'officialCommunications', 'Approvals and notices are valid only through the official email, portal, or communication channels recorded for the account.',
    'generalTerms', 'This agreement and approved schedules form the complete agreement. Amendments must be written and authorized.',
    'governingLaw', 'The governing law and competent courts are those stated in the signed contract particulars.'
  ),
  jsonb_build_object(
    'paymentTerms', seed.payment_terms,
    'advertisingBudget', seed.ad_budget,
    'revisionPolicy', seed.revision_policy
  ), true
from (values
  ('social_media','Social Media Management','Social Media',
    'Strategy, content planning, copywriting, design coordination, publishing and agreed community-management activities.',
    'Monthly calendar, agreed content formats, performance summary and approval workflow.',
    'Monthly in advance','Media spend is separate unless explicitly included.','Two revision rounds per scheduled deliverable.'),
  ('performance_marketing','Performance Marketing','Performance Marketing',
    'Campaign planning, media buying, tracking review, optimization and periodic performance reporting.',
    'Campaign setup, optimization log, dashboard/reporting and budget pacing.',
    'Monthly in advance','Advertising budget is funded directly by the Client and is not an Agency fee.','Creative and landing-page changes outside scope are quoted separately.'),
  ('website_development','Website Development','Website Development',
    'Discovery, UX/UI, implementation, content integration, testing and launch support for the approved specification.',
    'Approved pages, responsive implementation, QA, deployment handover and agreed documentation.',
    'Milestone payments','Hosting, paid plugins, licenses and third-party services are separate unless listed.','Two consolidated revision rounds per design milestone.'),
  ('branding','Branding','Branding',
    'Brand discovery, positioning, identity direction and production of the approved brand-system deliverables.',
    'Approved identity assets, usage guidance and agreed export formats.',
    '50% upfront and 50% before final files','Printing, trademark registration and third-party licenses are excluded.','Two revision rounds on the selected direction.'),
  ('production','Production','Production',
    'Pre-production, production and post-production services described in the approved treatment and schedule.',
    'Approved footage, edits and final masters in the agreed formats.',
    '50% booking deposit and balance before final masters','Locations, talent, permits, travel and third-party production costs are separate unless listed.','Two consolidated edit rounds.'),
  ('retainer','Retainer','Retainer',
    'Ongoing monthly services and priorities within the approved retainer capacity and service schedule.',
    'Monthly capacity, recurring deliverables, account management and performance review.',
    'Monthly in advance','Media, production and third-party costs are separate unless listed.','Revisions follow each service schedule.'),
  ('one_time_project','One-time Project','One-time Project',
    'Delivery of the defined project scope and milestones stated in this agreement.',
    'The deliverables, formats and acceptance criteria listed in the approved scope.',
    '50% upfront and 50% before final delivery','Third-party costs are separate unless listed.','Two revision rounds per milestone.')
) as seed(template_key,name,service_type,scope_text,deliverables_text,payment_terms,ad_budget,revision_policy)
on conflict do nothing;

create or replace function public.validate_contract_v2_legacy_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_status text;
  old_status text;
begin
  if new.coll <> 'contracts' or new.deleted_at is not null
      or lower(coalesce(new.data->>'_del', 'false')) = 'true' then return new; end if;
  if nullif(btrim(new.data->>'clientId'), '') is null then
    raise exception using errcode = '23514', message = 'contract_client_required';
  end if;
  perform 1 from public.records client
  where client.organization_id = new.organization_id and client.coll = 'clients'
    and client.id = new.data->>'clientId' and client.deleted_at is null
    and lower(coalesce(client.data->>'_del', 'false')) <> 'true';
  if not found then raise exception using errcode = '23503', message = 'contract_client_not_found'; end if;
  if nullif(btrim(new.data->>'projectId'), '') is not null then
    perform 1 from public.records project
    where project.organization_id = new.organization_id and project.coll = 'projects'
      and project.id = new.data->>'projectId'
      and project.data->>'clientId' = new.data->>'clientId'
      and project.deleted_at is null and lower(coalesce(project.data->>'_del', 'false')) <> 'true';
    if not found then raise exception using errcode = '23503', message = 'contract_project_client_mismatch'; end if;
  end if;
  new_status := public.normalize_contract_v2_status(new.data->>'status');
  if tg_op = 'INSERT' and new_status <> 'Draft' then
    raise exception using errcode = '23514', message = 'new_contract_must_be_draft';
  end if;
  if tg_op = 'UPDATE' then
    old_status := public.normalize_contract_v2_status(old.data->>'status');
    if new_status <> old_status and coalesce(current_setting('app.contract_command', true), '') <> '1' then
      raise exception using errcode = '42501', message = 'contract_status_command_required';
    end if;
    if old_status not in ('Draft','Internal Review') and new.data <> old.data
       and coalesce(current_setting('app.contract_command', true), '') <> '1' then
      raise exception using errcode = '42501', message = 'contract_locked_after_ready';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists records_validate_contract_v2 on public.records;
create trigger records_validate_contract_v2
  before insert or update on public.records
  for each row when (new.coll = 'contracts')
  execute function public.validate_contract_v2_legacy_record();

create or replace function public.sync_contract_v2_from_legacy_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d jsonb := coalesce(new.data, '{}'::jsonb);
  canonical_client public.client_accounts%rowtype;
  existing_contract public.agency_contracts%rowtype;
  normalized_status text;
  template_sections jsonb := '{}'::jsonb;
  template_terms jsonb := '{}'::jsonb;
begin
  if new.coll <> 'contracts' then return new; end if;
  if new.deleted_at is not null or lower(coalesce(d->>'_del', 'false')) = 'true' then
    update public.agency_contracts
    set deleted_at = coalesce(new.deleted_at, now()), archived_at = coalesce(archived_at, now()),
        updated_at = now(), version = version + 1
    where organization_id = new.organization_id and legacy_record_id = new.id and deleted_at is null;
    return new;
  end if;
  select * into canonical_client from public.client_accounts
  where organization_id = new.organization_id and legacy_record_id = d->>'clientId'
    and deleted_at is null;
  if canonical_client.id is null then
    insert into public.contract_projection_issues(organization_id, legacy_record_id, issue_code)
    values (new.organization_id, new.id, 'MISSING_CLIENT')
    on conflict (organization_id, legacy_record_id, issue_code)
    do update set last_seen_at = now(), resolved_at = null;
    return new;
  end if;
  normalized_status := public.normalize_contract_v2_status(d->>'status');
  select * into existing_contract from public.agency_contracts
  where organization_id = new.organization_id and legacy_record_id = new.id;
  select template.default_sections, template.default_terms
  into template_sections, template_terms
  from public.contract_templates template
  where template.organization_id is null and template.template_key = coalesce(nullif(d->>'templateKey',''), 'retainer')
    and template.deleted_at is null and template.is_active
  limit 1;

  insert into public.agency_contracts (
    organization_id, legacy_record_id, client_account_id, legacy_client_id,
    legacy_project_id, template_key, contract_number, contract_type, status,
    start_date, end_date, currency, contract_value, payment_terms,
    scope_summary, sections, payload, signed_at, archived_at, created_at
  ) values (
    new.organization_id, new.id, canonical_client.id, canonical_client.legacy_record_id,
    nullif(btrim(d->>'projectId'), ''), coalesce(nullif(btrim(d->>'templateKey'), ''), 'retainer'),
    coalesce(nullif(btrim(d->>'contractNumber'), ''), 'CTR-' || upper(left(replace(new.id, '-', ''), 12))),
    coalesce(nullif(btrim(d->>'contractType'), ''), 'Retainer'), normalized_status,
    nullif(d->>'startDate','')::date, nullif(d->>'endDate','')::date,
    coalesce(nullif(upper(btrim(d->>'currency')), ''), 'EGP'),
    greatest(0, public.finance_number(d->'value')),
    coalesce(nullif(btrim(d->>'paymentTerms'), ''), template_terms->>'paymentTerms'),
    coalesce(nullif(btrim(d->>'scope'), ''), template_sections->>'scope'),
    coalesce(d->'sections', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'definitions', coalesce(nullif(d->>'definitions',''), template_sections->>'definitions'),
      'scope', coalesce(nullif(d->>'scope',''), template_sections->>'scope'),
      'kpis', coalesce(nullif(d->>'kpis',''), template_sections->>'kpis'),
      'deliverables', coalesce(nullif(d->>'deliverables',''), template_sections->>'deliverables'),
      'latePaymentPolicy', coalesce(nullif(d->>'latePaymentPolicy',''), template_sections->>'latePaymentPolicy'),
      'agencyResponsibilities', coalesce(nullif(d->>'agencyResponsibilities',''), template_sections->>'agencyResponsibilities'),
      'clientResponsibilities', coalesce(nullif(d->>'clientResponsibilities',''), template_sections->>'clientResponsibilities'),
      'workingHours', coalesce(nullif(d->>'workingHours',''), template_sections->>'workingHours'),
      'outOfScope', coalesce(nullif(d->>'outOfScope',''), template_sections->>'outOfScope'),
      'exclusions', coalesce(nullif(d->>'exclusions',''), template_sections->>'exclusions'),
      'intellectualProperty', coalesce(nullif(d->>'intellectualProperty',''), template_sections->>'intellectualProperty'),
      'confidentiality', coalesce(nullif(d->>'confidentiality',''), template_sections->>'confidentiality'),
      'portfolioUsage', coalesce(nullif(d->>'portfolioUsage',''), template_sections->>'portfolioUsage'),
      'liability', coalesce(nullif(d->>'liability',''), template_sections->>'liability'),
      'forceMajeure', coalesce(nullif(d->>'forceMajeure',''), template_sections->>'forceMajeure'),
      'officialCommunications', coalesce(nullif(d->>'officialCommunications',''), template_sections->>'officialCommunications'),
      'generalTerms', coalesce(nullif(d->>'generalTerms',''), template_sections->>'generalTerms'),
      'governingLaw', coalesce(nullif(d->>'governingLaw',''), template_sections->>'governingLaw'),
      'additionalConditions', nullif(d->>'additionalConditions','')
    )), d, nullif(d->>'signedAt','')::timestamptz,
    nullif(d->>'archivedAt','')::timestamptz, coalesce(new.created_at, now())
  )
  on conflict (organization_id, legacy_record_id) do update set
    client_account_id = excluded.client_account_id,
    legacy_client_id = excluded.legacy_client_id,
    legacy_project_id = excluded.legacy_project_id,
    template_key = excluded.template_key,
    contract_number = excluded.contract_number,
    contract_type = excluded.contract_type,
    status = excluded.status,
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    currency = excluded.currency,
    contract_value = excluded.contract_value,
    payment_terms = excluded.payment_terms,
    scope_summary = excluded.scope_summary,
    sections = excluded.sections,
    payload = excluded.payload,
    signed_at = excluded.signed_at,
    archived_at = excluded.archived_at,
    deleted_at = null,
    updated_at = now(),
    version = public.agency_contracts.version + 1;

  if existing_contract.id is null then
    insert into public.contract_status_events(organization_id, contract_id, from_status, to_status, actor_user_id, note)
    select new.organization_id, contract.id, null, contract.status, auth.uid(), 'Contract imported or created'
    from public.agency_contracts contract
    where contract.organization_id = new.organization_id and contract.legacy_record_id = new.id;
  elsif existing_contract.status <> normalized_status then
    insert into public.contract_status_events(organization_id, contract_id, from_status, to_status, actor_user_id, note)
    select new.organization_id, contract.id, existing_contract.status, normalized_status, auth.uid(),
      nullif(current_setting('app.contract_note', true), '')
    from public.agency_contracts contract
    where contract.organization_id = new.organization_id and contract.legacy_record_id = new.id;
  end if;
  update public.contract_projection_issues set resolved_at = now(), last_seen_at = now()
  where organization_id = new.organization_id and legacy_record_id = new.id
    and issue_code = 'MISSING_CLIENT' and resolved_at is null;
  return new;
end;
$$;

drop trigger if exists records_sync_contract_v2 on public.records;
create trigger records_sync_contract_v2
  after insert or update on public.records
  for each row execute function public.sync_contract_v2_from_legacy_record();

drop trigger if exists contract_templates_set_updated_at on public.contract_templates;
create trigger contract_templates_set_updated_at before update on public.contract_templates
  for each row execute function public.set_saas_updated_at();
drop trigger if exists agency_contracts_set_updated_at on public.agency_contracts;
create trigger agency_contracts_set_updated_at before update on public.agency_contracts
  for each row execute function public.set_saas_updated_at();
drop trigger if exists contract_status_events_append_only on public.contract_status_events;
create trigger contract_status_events_append_only before update or delete on public.contract_status_events
  for each row execute function public.prevent_event_mutation();

update public.records set data = data
where coll = 'contracts' and deleted_at is null
  and lower(coalesce(data->>'_del', 'false')) <> 'true';

do $$
declare expected_count integer;
declare actual_count integer;
begin
  select count(*) into expected_count from public.records record
  where record.coll = 'contracts' and record.deleted_at is null
    and lower(coalesce(record.data->>'_del', 'false')) <> 'true'
    and exists (select 1 from public.client_accounts client
      where client.organization_id = record.organization_id
        and client.legacy_record_id = record.data->>'clientId' and client.deleted_at is null);
  select count(*) into actual_count from public.agency_contracts where deleted_at is null;
  if expected_count <> actual_count then
    raise exception 'M8 contract projection mismatch: expected %, got %', expected_count, actual_count;
  end if;
end $$;

create or replace function public.list_contract_templates_v2(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_org_capability(p_organization_id, 'clients.read') then
    raise exception using errcode = '42501', message = 'client_read_required';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'key', template.template_key, 'name', template.name,
    'serviceType', template.service_type, 'language', template.language,
    'sections', template.default_sections, 'terms', template.default_terms,
    'system', template.is_system, 'version', template.version
  ) order by template.is_system desc, template.name)
  from public.contract_templates template
  where template.deleted_at is null and template.is_active
    and (template.organization_id is null or template.organization_id = p_organization_id)), '[]'::jsonb);
end;
$$;

create or replace function public.list_contracts_v2(
  p_organization_id uuid,
  p_search text default null,
  p_status text default null,
  p_legacy_client_id text default null,
  p_template_key text default null,
  p_page integer default 1,
  p_page_size integer default 25,
  p_include_archived boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare normalized_search text := left(btrim(coalesce(p_search, '')), 120);
declare page_number integer := greatest(1, coalesce(p_page, 1));
declare page_size integer := greatest(1, least(coalesce(p_page_size, 25), 100));
declare total_rows integer;
declare items jsonb;
begin
  if not public.has_org_capability(p_organization_id, 'clients.read') then
    raise exception using errcode = '42501', message = 'client_read_required';
  end if;
  select count(*)::integer into total_rows
  from public.agency_contracts contract
  join public.client_accounts client on client.organization_id = contract.organization_id
    and client.id = contract.client_account_id
  where contract.organization_id = p_organization_id and contract.deleted_at is null
    and (p_include_archived or contract.archived_at is null)
    and (p_status is null or contract.status = p_status)
    and (p_legacy_client_id is null or contract.legacy_client_id = p_legacy_client_id)
    and (p_template_key is null or contract.template_key = p_template_key)
    and (normalized_search = '' or concat_ws(' ', contract.contract_number,
      contract.contract_type, client.display_name, contract.scope_summary)
      ilike '%' || normalized_search || '%');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', contract.id, 'legacyRecordId', contract.legacy_record_id,
    'contractNumber', contract.contract_number, 'clientId', contract.legacy_client_id,
    'clientName', client.display_name, 'projectId', contract.legacy_project_id,
    'templateKey', contract.template_key, 'contractType', contract.contract_type,
    'status', contract.status, 'startDate', contract.start_date, 'endDate', contract.end_date,
    'currency', contract.currency, 'value', contract.contract_value,
    'signedAt', contract.signed_at, 'archivedAt', contract.archived_at,
    'activeLinks', (select count(*) from public.contract_access_links link
      where link.organization_id = contract.organization_id and link.contract_id = contract.id
        and link.state = 'ACTIVE' and link.expires_at > now()),
    'version', contract.version, 'updatedAt', contract.updated_at
  ) order by contract.updated_at desc), '[]'::jsonb) into items
  from (select contract.* from public.agency_contracts contract
    join public.client_accounts client_filter on client_filter.organization_id = contract.organization_id
      and client_filter.id = contract.client_account_id
    where contract.organization_id = p_organization_id and contract.deleted_at is null
      and (p_include_archived or contract.archived_at is null)
      and (p_status is null or contract.status = p_status)
      and (p_legacy_client_id is null or contract.legacy_client_id = p_legacy_client_id)
      and (p_template_key is null or contract.template_key = p_template_key)
      and (normalized_search = '' or concat_ws(' ', contract.contract_number,
        contract.contract_type, client_filter.display_name, contract.scope_summary)
        ilike '%' || normalized_search || '%')
    order by contract.updated_at desc
    offset ((page_number - 1) * page_size) limit page_size) contract
  join public.client_accounts client on client.organization_id = contract.organization_id
    and client.id = contract.client_account_id;

  return jsonb_build_object('items', coalesce(items,'[]'::jsonb), 'total', total_rows,
    'page', page_number, 'pages', greatest(1, ceil(total_rows::numeric/page_size)::integer));
end;
$$;

create or replace function public.get_contract_v2(p_organization_id uuid, p_legacy_contract_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare contract_row public.agency_contracts%rowtype;
declare client_row public.client_accounts%rowtype;
begin
  if not public.has_org_capability(p_organization_id, 'clients.read') then
    raise exception using errcode = '42501', message = 'client_read_required';
  end if;
  select * into contract_row from public.agency_contracts contract
  where contract.organization_id = p_organization_id
    and contract.legacy_record_id = p_legacy_contract_id and contract.deleted_at is null;
  if contract_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into client_row from public.client_accounts client
  where client.organization_id = p_organization_id and client.id = contract_row.client_account_id;
  return jsonb_build_object(
    'ok', true,
    'contract', jsonb_build_object(
      'id', contract_row.id, 'legacyRecordId', contract_row.legacy_record_id,
      'contractNumber', contract_row.contract_number, 'clientId', contract_row.legacy_client_id,
      'clientName', client_row.display_name, 'clientLegalName', client_row.legal_name,
      'clientEmail', client_row.primary_contact_email, 'projectId', contract_row.legacy_project_id,
      'templateKey', contract_row.template_key, 'contractType', contract_row.contract_type,
      'status', contract_row.status, 'startDate', contract_row.start_date,
      'endDate', contract_row.end_date, 'currency', contract_row.currency,
      'value', contract_row.contract_value, 'paymentTerms', contract_row.payment_terms,
      'scope', contract_row.scope_summary, 'sections', contract_row.sections,
      'payload', contract_row.payload, 'signedAt', contract_row.signed_at,
      'archivedAt', contract_row.archived_at, 'version', contract_row.version
    ),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'fromStatus', event.from_status, 'toStatus', event.to_status,
      'note', event.note, 'occurredAt', event.occurred_at
    ) order by event.occurred_at desc) from public.contract_status_events event
      where event.organization_id = p_organization_id and event.contract_id = contract_row.id), '[]'::jsonb),
    'links', case when public.has_org_capability(p_organization_id, 'clients.manage') then
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', link.id, 'state', case when link.state='ACTIVE' and link.expires_at<=now() then 'EXPIRED' else link.state end,
        'purpose', link.purpose, 'expiresAt', link.expires_at, 'useCount', link.use_count,
        'acceptedAt', link.accepted_at, 'createdAt', link.created_at
      ) order by link.created_at desc) from public.contract_access_links link
        where link.organization_id = p_organization_id and link.contract_id = contract_row.id), '[]'::jsonb)
      else '[]'::jsonb end
  );
end;
$$;

create or replace function public.change_contract_v2_status(
  p_organization_id uuid, p_legacy_contract_id text, p_to_status text, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare contract_row public.agency_contracts%rowtype;
declare next_status text := public.normalize_contract_v2_status(p_to_status);
declare allowed boolean := false;
begin
  if not public.has_org_capability(p_organization_id, 'clients.manage') then
    raise exception using errcode = '42501', message = 'client_manage_required';
  end if;
  select * into contract_row from public.agency_contracts contract
  where contract.organization_id = p_organization_id
    and contract.legacy_record_id = p_legacy_contract_id and contract.deleted_at is null
  for update;
  if contract_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  allowed := case contract_row.status
    when 'Draft' then next_status in ('Internal Review','Cancelled')
    when 'Internal Review' then next_status in ('Draft','Ready','Cancelled')
    when 'Ready' then next_status in ('Draft','Sent','Cancelled')
    when 'Sent' then next_status in ('Signed','Cancelled')
    when 'Signed' then next_status in ('Active','Cancelled')
    when 'Active' then next_status in ('Expired','Cancelled')
    when 'Expired' then next_status in ('Active','Cancelled')
    else false end;
  if not allowed then raise exception using errcode='P0001', message='invalid_contract_transition'; end if;
  perform set_config('app.contract_command','1',true);
  perform set_config('app.contract_note',coalesce(left(btrim(p_note),1000),''),true);
  update public.records set data = data || jsonb_build_object(
    'status', next_status,
    'signedAt', case when next_status='Signed' then now() else nullif(data->>'signedAt','')::timestamptz end,
    'updatedAt', now()
  ), updated_at = now()
  where organization_id = p_organization_id and id = p_legacy_contract_id and coll = 'contracts';
  insert into public.audit_events(organization_id, actor_user_id, action, entity_type, entity_id, safe_context)
  values (p_organization_id, auth.uid(), 'CONTRACT_STATUS_CHANGED', 'contract', contract_row.id::text,
    jsonb_build_object('from',contract_row.status,'to',next_status));
  return jsonb_build_object('ok',true,'status',next_status);
end;
$$;

create or replace function public.duplicate_contract_v2(
  p_organization_id uuid, p_legacy_contract_id text, p_contract_number text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare source_record public.records%rowtype;
declare new_id text := 'ctr-' || replace(gen_random_uuid()::text,'-','');
begin
  if not public.has_org_capability(p_organization_id, 'clients.manage') then
    raise exception using errcode = '42501', message = 'client_manage_required';
  end if;
  if char_length(btrim(coalesce(p_contract_number,''))) not between 3 and 80 then
    raise exception using errcode='P0001', message='invalid_contract_number';
  end if;
  select * into source_record from public.records record
  where record.organization_id=p_organization_id and record.id=p_legacy_contract_id
    and record.coll='contracts' and record.deleted_at is null;
  if source_record.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  insert into public.records(id,coll,data,organization_id)
  values (new_id,'contracts',(source_record.data - array['signedAt','archivedAt']) || jsonb_build_object(
    'id',new_id,'contractNumber',btrim(p_contract_number),'status','Draft',
    'createdAt',now(),'updatedAt',now()
  ),p_organization_id);
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values (p_organization_id,auth.uid(),'CONTRACT_DUPLICATED','contract',new_id,
    jsonb_build_object('sourceContractId',p_legacy_contract_id));
  return jsonb_build_object('ok',true,'legacyRecordId',new_id);
end;
$$;

create or replace function public.archive_contract_v2(p_organization_id uuid, p_legacy_contract_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_org_capability(p_organization_id, 'clients.manage') then
    raise exception using errcode = '42501', message = 'client_manage_required';
  end if;
  perform set_config('app.contract_command','1',true);
  update public.records set data=data||jsonb_build_object('archivedAt',now(),'updatedAt',now()),updated_at=now()
  where organization_id=p_organization_id and id=p_legacy_contract_id and coll='contracts' and deleted_at is null;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values (p_organization_id,auth.uid(),'CONTRACT_ARCHIVED','contract',p_legacy_contract_id,'{}'::jsonb);
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.create_contract_access_link(
  p_organization_id uuid, p_legacy_contract_id text,
  p_expires_hours integer default 72, p_purpose text default 'REVIEW_AND_SIGN'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare contract_row public.agency_contracts%rowtype;
declare raw_token text;
declare link_row public.contract_access_links%rowtype;
declare normalized_purpose text := upper(btrim(coalesce(p_purpose,'REVIEW_AND_SIGN')));
begin
  if not public.has_org_capability(p_organization_id, 'clients.manage') then
    raise exception using errcode = '42501', message = 'client_manage_required';
  end if;
  if p_expires_hours not between 1 and 336 then raise exception using errcode='P0001',message='invalid_expiry'; end if;
  if normalized_purpose not in ('REVIEW','REVIEW_AND_SIGN') then raise exception using errcode='P0001',message='invalid_purpose'; end if;
  select * into contract_row from public.agency_contracts contract
  where contract.organization_id=p_organization_id and contract.legacy_record_id=p_legacy_contract_id
    and contract.deleted_at is null and contract.archived_at is null for update;
  if contract_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if contract_row.status not in ('Ready','Sent','Signed','Active') then
    raise exception using errcode='P0001',message='contract_not_ready_to_share';
  end if;
  raw_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.contract_access_links(
    organization_id,contract_id,token_hash,purpose,expires_at,created_by
  ) values (
    p_organization_id,contract_row.id,encode(extensions.digest(raw_token,'sha256'),'hex'),
    normalized_purpose,now()+make_interval(hours=>p_expires_hours),auth.uid()
  ) returning * into link_row;
  if contract_row.status='Ready' then
    perform set_config('app.contract_command','1',true);
    update public.records set data=data||jsonb_build_object('status','Sent','sentAt',now(),'updatedAt',now()),updated_at=now()
    where organization_id=p_organization_id and id=p_legacy_contract_id and coll='contracts';
  end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values (p_organization_id,auth.uid(),'CONTRACT_ACCESS_CREATED','contract',contract_row.id::text,
    jsonb_build_object('linkId',link_row.id,'purpose',normalized_purpose,'expiresAt',link_row.expires_at));
  return jsonb_build_object('ok',true,'id',link_row.id,'token',raw_token,
    'expiresAt',link_row.expires_at,'purpose',link_row.purpose);
end;
$$;

create or replace function public.get_public_contract(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare link_row public.contract_access_links%rowtype;
declare contract_row public.agency_contracts%rowtype;
declare client_row public.client_accounts%rowtype;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok',false,'error','invalid_or_expired');
  end if;
  select * into link_row from public.contract_access_links link
  where link.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if link_row.id is null or link_row.state not in ('ACTIVE','ACCEPTED')
    or link_row.expires_at<=now() or link_row.use_count>=link_row.max_uses then
    return jsonb_build_object('ok',false,'error','invalid_or_expired');
  end if;
  select * into contract_row from public.agency_contracts contract
  where contract.organization_id=link_row.organization_id and contract.id=link_row.contract_id
    and contract.deleted_at is null and contract.archived_at is null;
  if contract_row.id is null then return jsonb_build_object('ok',false,'error','invalid_or_expired'); end if;
  select * into client_row from public.client_accounts client
  where client.organization_id=contract_row.organization_id and client.id=contract_row.client_account_id;
  update public.contract_access_links set use_count=use_count+1,last_accessed_at=now() where id=link_row.id;
  return jsonb_build_object(
    'ok',true,'purpose',link_row.purpose,'state',link_row.state,'expiresAt',link_row.expires_at,
    'acceptedAt',link_row.accepted_at,'agency',jsonb_build_object('name','Magnet'),
    'client',jsonb_build_object('name',client_row.display_name,'legalName',client_row.legal_name),
    'contract',jsonb_build_object(
      'contractNumber',contract_row.contract_number,'contractType',contract_row.contract_type,
      'status',contract_row.status,'startDate',contract_row.start_date,'endDate',contract_row.end_date,
      'currency',contract_row.currency,'value',contract_row.contract_value,
      'paymentTerms',contract_row.payment_terms,'scope',contract_row.scope_summary,
      'sections',contract_row.sections
    )
  );
end;
$$;

create or replace function public.accept_public_contract(
  p_token text, p_signer_name text, p_signer_email text, p_consent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare link_row public.contract_access_links%rowtype;
declare contract_row public.agency_contracts%rowtype;
declare email_value text := lower(btrim(coalesce(p_signer_email,'')));
begin
  if p_consent is not true or char_length(btrim(coalesce(p_signer_name,''))) not between 2 and 160
    or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode='P0001',message='invalid_signature_details';
  end if;
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok',false,'error','invalid_or_expired');
  end if;
  select * into link_row from public.contract_access_links link
  where link.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if link_row.id is null or link_row.purpose<>'REVIEW_AND_SIGN' or link_row.state<>'ACTIVE'
    or link_row.expires_at<=now() or link_row.use_count>=link_row.max_uses then
    return jsonb_build_object('ok',false,'error','invalid_or_expired');
  end if;
  select * into contract_row from public.agency_contracts contract
  where contract.organization_id=link_row.organization_id and contract.id=link_row.contract_id
    and contract.status='Sent' and contract.deleted_at is null and contract.archived_at is null for update;
  if contract_row.id is null then return jsonb_build_object('ok',false,'error','not_signable'); end if;
  update public.contract_access_links set state='ACCEPTED',accepted_at=now(),
    signer_name=btrim(p_signer_name),signer_email_normalized=email_value,
    use_count=use_count+1,last_accessed_at=now()
  where id=link_row.id;
  perform set_config('app.contract_command','1',true);
  update public.records set data=data||jsonb_build_object('status','Signed','signedAt',now(),'updatedAt',now()),updated_at=now()
  where organization_id=contract_row.organization_id and id=contract_row.legacy_record_id and coll='contracts';
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values (contract_row.organization_id,null,'CONTRACT_ACCEPTED','contract',contract_row.id::text,
    jsonb_build_object('linkId',link_row.id));
  return jsonb_build_object('ok',true,'status','Signed','acceptedAt',now());
end;
$$;

create or replace function public.revoke_contract_access_link(p_organization_id uuid,p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_org_capability(p_organization_id,'clients.manage') then
    raise exception using errcode='42501',message='client_manage_required';
  end if;
  update public.contract_access_links set state='REVOKED',revoked_at=now()
  where organization_id=p_organization_id and id=p_link_id and state='ACTIVE';
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values (p_organization_id,auth.uid(),'CONTRACT_ACCESS_REVOKED','contract_access_link',p_link_id::text,'{}'::jsonb);
  return jsonb_build_object('ok',true);
end;
$$;

alter table public.contract_templates enable row level security;
alter table public.agency_contracts enable row level security;
alter table public.contract_status_events enable row level security;
alter table public.contract_access_links enable row level security;
alter table public.contract_projection_issues enable row level security;

revoke all privileges on public.contract_templates,public.agency_contracts,
  public.contract_status_events,public.contract_access_links,public.contract_projection_issues
  from public,anon,authenticated;
grant select,insert,update,delete on public.contract_templates,public.agency_contracts,
  public.contract_status_events,public.contract_access_links,public.contract_projection_issues to service_role;
grant usage,select on sequence public.contract_status_events_id_seq,
  public.contract_projection_issues_id_seq to service_role;

create policy contract_templates_member_read on public.contract_templates
  for select to authenticated
  using (deleted_at is null and is_active and (
    organization_id is null or public.has_org_capability(organization_id,'clients.read')
  ));
create policy agency_contracts_member_read on public.agency_contracts
  for select to authenticated
  using (deleted_at is null and public.has_org_capability(organization_id,'clients.read'));
create policy contract_status_events_member_read on public.contract_status_events
  for select to authenticated
  using (public.has_org_capability(organization_id,'clients.read'));
create policy contract_access_links_manager_read on public.contract_access_links
  for select to authenticated
  using (public.has_org_capability(organization_id,'clients.manage'));
create policy contract_projection_issues_manager_read on public.contract_projection_issues
  for select to authenticated
  using (public.has_org_capability(organization_id,'clients.manage'));
grant select on public.contract_templates,public.agency_contracts,public.contract_status_events,
  public.contract_access_links,public.contract_projection_issues to authenticated;

revoke all on function public.list_contract_templates_v2(uuid) from public,anon;
revoke all on function public.list_contracts_v2(uuid,text,text,text,text,integer,integer,boolean) from public,anon;
revoke all on function public.get_contract_v2(uuid,text) from public,anon;
revoke all on function public.change_contract_v2_status(uuid,text,text,text) from public,anon;
revoke all on function public.duplicate_contract_v2(uuid,text,text) from public,anon;
revoke all on function public.archive_contract_v2(uuid,text) from public,anon;
revoke all on function public.create_contract_access_link(uuid,text,integer,text) from public,anon;
revoke all on function public.revoke_contract_access_link(uuid,uuid) from public,anon;
grant execute on function public.list_contract_templates_v2(uuid) to authenticated,service_role;
grant execute on function public.list_contracts_v2(uuid,text,text,text,text,integer,integer,boolean) to authenticated,service_role;
grant execute on function public.get_contract_v2(uuid,text) to authenticated,service_role;
grant execute on function public.change_contract_v2_status(uuid,text,text,text) to authenticated,service_role;
grant execute on function public.duplicate_contract_v2(uuid,text,text) to authenticated,service_role;
grant execute on function public.archive_contract_v2(uuid,text) to authenticated,service_role;
grant execute on function public.create_contract_access_link(uuid,text,integer,text) to authenticated,service_role;
grant execute on function public.revoke_contract_access_link(uuid,uuid) to authenticated,service_role;

revoke all on function public.get_public_contract(text) from public;
revoke all on function public.accept_public_contract(text,text,text,boolean) from public;
grant execute on function public.get_public_contract(text) to anon,authenticated,service_role;
grant execute on function public.accept_public_contract(text,text,text,boolean) to anon,authenticated,service_role;

insert into public.migration_audit(migration,note)
values ('20260825233000_contract_management_v2',
  'Added canonical contracts, seven master templates, server lifecycle commands, hashed expiring review/sign links, public acceptance, audit history, and tenant-safe RLS.');

commit;

-- Forward-only rollback: revoke public review RPCs, revoke creation commands,
-- and route the UI back to legacy contracts. Preserve contracts, status history,
-- acceptance evidence, access-link hashes, and audit events.
