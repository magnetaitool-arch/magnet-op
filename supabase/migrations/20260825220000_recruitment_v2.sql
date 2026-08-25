-- MAGNET OS V2 / M5: canonical recruitment pipeline and applicant profiles.
--
-- Legacy `records/candidates` remains available during the controlled migration.
-- An additive trigger projects every existing/future candidate into the
-- canonical recruitment model. Lifecycle commands update the legacy row in one
-- transaction so old screens and newer V2 screens cannot silently diverge.

begin;

create table if not exists public.applicants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null references public.records(id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 240),
  email_normalized text,
  phone text,
  position text,
  stage text not null default 'New'
    check (stage in ('New','Screening','Interview','Offer','Hired','Rejected','Archived')),
  source text not null default 'Manual',
  applied_at timestamptz not null,
  area text,
  specialization text,
  experience text,
  available_from date,
  current_salary numeric(16,2),
  expected_salary numeric(16,2),
  workplaces text,
  courses text,
  cv_url text,
  portfolio_url text,
  rating numeric(4,2) not null default 0 check (rating between 0 and 5),
  game_score numeric(12,2),
  owner_employee_id text,
  converted_employee_id text,
  application_answers jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  unique (organization_id, legacy_record_id),
  unique (organization_id, id)
);

create index if not exists applicants_org_stage_applied_idx
  on public.applicants (organization_id, stage, applied_at desc)
  where deleted_at is null;
create index if not exists applicants_org_name_idx
  on public.applicants (organization_id, lower(full_name))
  where deleted_at is null;
create index if not exists applicants_org_email_idx
  on public.applicants (organization_id, email_normalized)
  where deleted_at is null and email_normalized is not null;

create table if not exists public.applicant_stage_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  applicant_id uuid not null,
  from_stage text,
  to_stage text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  note text,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, applicant_id)
    references public.applicants(organization_id, id) on delete restrict
);

create index if not exists applicant_stage_events_applicant_idx
  on public.applicant_stage_events (organization_id, applicant_id, occurred_at desc);

create table if not exists public.applicant_interviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  applicant_id uuid not null,
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 45 check (duration_minutes between 10 and 480),
  mode text not null default 'Online' check (mode in ('Online','Office','Phone')),
  location_or_link text,
  interviewer_user_id uuid references public.profiles(id) on delete set null,
  status text not null default 'Scheduled'
    check (status in ('Scheduled','Completed','Cancelled','No Show')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, applicant_id)
    references public.applicants(organization_id, id) on delete restrict
);

create index if not exists applicant_interviews_applicant_idx
  on public.applicant_interviews (organization_id, applicant_id, scheduled_at desc);

create table if not exists public.applicant_notes (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  applicant_id uuid not null,
  note text not null check (char_length(btrim(note)) between 1 and 5000),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, applicant_id)
    references public.applicants(organization_id, id) on delete restrict
);

create index if not exists applicant_notes_applicant_idx
  on public.applicant_notes (organization_id, applicant_id, created_at desc);

create or replace function public.normalize_applicant_stage(p_stage text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(btrim(coalesce(p_stage, '')))
    when 'new' then 'New'
    when 'screening' then 'Screening'
    when 'shortlisted' then 'Screening'
    when 'interview' then 'Interview'
    when 'offer' then 'Offer'
    when 'hired' then 'Hired'
    when 'rejected' then 'Rejected'
    when 'declined' then 'Rejected'
    when 'archived' then 'Archived'
    else 'New'
  end;
$$;

create or replace function public.sync_applicant_from_legacy_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_data jsonb := coalesce(new.data, '{}'::jsonb);
  normalized_stage text;
  parsed_rating numeric := 0;
  parsed_game_score numeric;
  parsed_current_salary numeric;
  parsed_expected_salary numeric;
  parsed_available_from date;
begin
  if new.coll <> 'candidates' then return new; end if;

  if new.deleted_at is not null or lower(coalesce(candidate_data->>'_del', 'false')) = 'true' then
    update public.applicants
    set deleted_at = coalesce(new.deleted_at, now()), archived_at = coalesce(archived_at, now()),
        stage = 'Archived', updated_at = now(), version = version + 1
    where organization_id = new.organization_id and legacy_record_id = new.id and deleted_at is null;
    return new;
  end if;

  normalized_stage := public.normalize_applicant_stage(coalesce(candidate_data->>'stage', candidate_data->>'status'));
  if coalesce(candidate_data->>'rating', '') ~ '^[0-9]+([.][0-9]+)?$' then
    parsed_rating := least(5, greatest(0, (candidate_data->>'rating')::numeric));
  end if;
  if coalesce(candidate_data->>'gameScore', '') ~ '^-?[0-9]+([.][0-9]+)?$' then parsed_game_score := (candidate_data->>'gameScore')::numeric; end if;
  if coalesce(candidate_data->>'currentSalary', '') ~ '^[0-9]+([.][0-9]+)?$' then parsed_current_salary := (candidate_data->>'currentSalary')::numeric; end if;
  if coalesce(candidate_data->>'expectedSalary', '') ~ '^[0-9]+([.][0-9]+)?$' then parsed_expected_salary := (candidate_data->>'expectedSalary')::numeric; end if;
  begin parsed_available_from := nullif(candidate_data->>'availableFrom', '')::date; exception when others then parsed_available_from := null; end;

  insert into public.applicants (
    organization_id, legacy_record_id, full_name, email_normalized, phone, position,
    stage, source, applied_at, area, specialization, experience, available_from,
    current_salary, expected_salary, workplaces, courses, cv_url, portfolio_url,
    rating, game_score, owner_employee_id, converted_employee_id,
    application_answers, attachments, archived_at, deleted_at
  ) values (
    new.organization_id,
    new.id,
    coalesce(nullif(btrim(candidate_data->>'fullName'), ''), 'Unnamed applicant'),
    lower(nullif(btrim(candidate_data->>'email'), '')),
    nullif(btrim(candidate_data->>'mobile'), ''),
    nullif(btrim(candidate_data->>'position'), ''),
    normalized_stage,
    coalesce(nullif(btrim(candidate_data->>'source'), ''), 'Manual'),
    coalesce(new.created_at, now()),
    nullif(btrim(candidate_data->>'area'), ''),
    nullif(btrim(candidate_data->>'specialization'), ''),
    nullif(btrim(candidate_data->>'experience'), ''),
    parsed_available_from,
    parsed_current_salary,
    parsed_expected_salary,
    nullif(btrim(candidate_data->>'workplaces'), ''),
    nullif(btrim(candidate_data->>'courses'), ''),
    nullif(btrim(candidate_data->>'cvLink'), ''),
    coalesce(nullif(btrim(candidate_data->>'portfolioLink'), ''), nullif(btrim(candidate_data->>'portfolio'), '')),
    parsed_rating,
    parsed_game_score,
    nullif(btrim(candidate_data->>'ownerId'), ''),
    nullif(btrim(candidate_data->>'convertedEmployeeId'), ''),
    candidate_data,
    case when jsonb_typeof(candidate_data->'attachments') = 'array' then candidate_data->'attachments' else '[]'::jsonb end,
    case when normalized_stage = 'Archived' then now() else null end,
    null
  )
  on conflict (organization_id, legacy_record_id) do update
  set
    full_name = excluded.full_name,
    email_normalized = excluded.email_normalized,
    phone = excluded.phone,
    position = excluded.position,
    stage = excluded.stage,
    source = excluded.source,
    area = excluded.area,
    specialization = excluded.specialization,
    experience = excluded.experience,
    available_from = excluded.available_from,
    current_salary = excluded.current_salary,
    expected_salary = excluded.expected_salary,
    workplaces = excluded.workplaces,
    courses = excluded.courses,
    cv_url = excluded.cv_url,
    portfolio_url = excluded.portfolio_url,
    rating = excluded.rating,
    game_score = excluded.game_score,
    owner_employee_id = excluded.owner_employee_id,
    converted_employee_id = excluded.converted_employee_id,
    application_answers = excluded.application_answers,
    attachments = excluded.attachments,
    archived_at = case when excluded.stage = 'Archived' then coalesce(public.applicants.archived_at, now()) else null end,
    deleted_at = null,
    version = public.applicants.version + 1,
    updated_at = now();

  return new;
end;
$$;

create or replace function public.log_applicant_stage_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.applicant_stage_events (
      organization_id, applicant_id, from_stage, to_stage, actor_user_id, note
    ) values (
      new.organization_id, new.id, null, new.stage, auth.uid(),
      'Applicant profile created'
    );
  elsif new.stage is distinct from old.stage then
    insert into public.applicant_stage_events (
      organization_id, applicant_id, from_stage, to_stage, actor_user_id, note
    ) values (
      new.organization_id, new.id, old.stage, new.stage, auth.uid(), null
    );
  end if;
  return new;
end;
$$;

drop trigger if exists records_sync_applicant on public.records;
create trigger records_sync_applicant
  after insert or update on public.records
  for each row execute function public.sync_applicant_from_legacy_record();

drop trigger if exists applicants_stage_event on public.applicants;
create trigger applicants_stage_event
  after insert or update of stage on public.applicants
  for each row execute function public.log_applicant_stage_event();

drop trigger if exists applicants_set_updated_at on public.applicants;
create trigger applicants_set_updated_at before update on public.applicants
  for each row execute function public.set_saas_updated_at();
drop trigger if exists applicant_interviews_set_updated_at on public.applicant_interviews;
create trigger applicant_interviews_set_updated_at before update on public.applicant_interviews
  for each row execute function public.set_saas_updated_at();

drop trigger if exists applicant_stage_events_append_only on public.applicant_stage_events;
create trigger applicant_stage_events_append_only
  before update or delete on public.applicant_stage_events
  for each row execute function public.prevent_event_mutation();
drop trigger if exists applicant_notes_append_only on public.applicant_notes;
create trigger applicant_notes_append_only
  before update or delete on public.applicant_notes
  for each row execute function public.prevent_event_mutation();

-- Backfill every active legacy candidate without deleting or rewriting it.
insert into public.applicants (
  organization_id, legacy_record_id, full_name, email_normalized, phone, position,
  stage, source, applied_at, area, specialization, experience, available_from,
  current_salary, expected_salary, workplaces, courses, cv_url, portfolio_url,
  rating, game_score, owner_employee_id, converted_employee_id,
  application_answers, attachments
)
select
  record.organization_id,
  record.id,
  coalesce(nullif(btrim(record.data->>'fullName'), ''), 'Unnamed applicant'),
  lower(nullif(btrim(record.data->>'email'), '')),
  nullif(btrim(record.data->>'mobile'), ''),
  nullif(btrim(record.data->>'position'), ''),
  public.normalize_applicant_stage(coalesce(record.data->>'stage', record.data->>'status')),
  coalesce(nullif(btrim(record.data->>'source'), ''), 'Manual'),
  coalesce(record.created_at, now()),
  nullif(btrim(record.data->>'area'), ''),
  nullif(btrim(record.data->>'specialization'), ''),
  nullif(btrim(record.data->>'experience'), ''),
  case when coalesce(record.data->>'availableFrom', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (record.data->>'availableFrom')::date else null end,
  case when coalesce(record.data->>'currentSalary', '') ~ '^[0-9]+([.][0-9]+)?$' then (record.data->>'currentSalary')::numeric else null end,
  case when coalesce(record.data->>'expectedSalary', '') ~ '^[0-9]+([.][0-9]+)?$' then (record.data->>'expectedSalary')::numeric else null end,
  nullif(btrim(record.data->>'workplaces'), ''),
  nullif(btrim(record.data->>'courses'), ''),
  nullif(btrim(record.data->>'cvLink'), ''),
  coalesce(nullif(btrim(record.data->>'portfolioLink'), ''), nullif(btrim(record.data->>'portfolio'), '')),
  case when coalesce(record.data->>'rating', '') ~ '^[0-9]+([.][0-9]+)?$' then least(5, greatest(0, (record.data->>'rating')::numeric)) else 0 end,
  case when coalesce(record.data->>'gameScore', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (record.data->>'gameScore')::numeric else null end,
  nullif(btrim(record.data->>'ownerId'), ''),
  nullif(btrim(record.data->>'convertedEmployeeId'), ''),
  record.data,
  case when jsonb_typeof(record.data->'attachments') = 'array' then record.data->'attachments' else '[]'::jsonb end
from public.records record
where record.coll = 'candidates'
  and record.deleted_at is null
  and lower(coalesce(record.data->>'_del', 'false')) <> 'true'
on conflict (organization_id, legacy_record_id) do nothing;

do $$
declare
  legacy_count integer;
  canonical_count integer;
begin
  select count(*) into legacy_count
  from public.records
  where coll = 'candidates' and deleted_at is null
    and lower(coalesce(data->>'_del', 'false')) <> 'true';
  select count(*) into canonical_count from public.applicants where deleted_at is null;
  if canonical_count <> legacy_count then
    raise exception 'Applicant backfill mismatch: legacy %, canonical %', legacy_count, canonical_count;
  end if;
end $$;

alter table public.applicants enable row level security;
alter table public.applicant_stage_events enable row level security;
alter table public.applicant_interviews enable row level security;
alter table public.applicant_notes enable row level security;

revoke all privileges on public.applicants from public, anon, authenticated;
revoke all privileges on public.applicant_stage_events from public, anon, authenticated;
revoke all privileges on public.applicant_interviews from public, anon, authenticated;
revoke all privileges on public.applicant_notes from public, anon, authenticated;
grant select, insert, update, delete on public.applicants to service_role;
grant select, insert, update, delete on public.applicant_stage_events to service_role;
grant select, insert, update, delete on public.applicant_interviews to service_role;
grant select, insert, update, delete on public.applicant_notes to service_role;
grant usage, select on sequence public.applicant_stage_events_id_seq to service_role;
grant usage, select on sequence public.applicant_notes_id_seq to service_role;

create policy applicants_hr_read on public.applicants
  for select to authenticated
  using (deleted_at is null and public.has_org_capability(organization_id, 'hr.read'));
create policy applicant_stage_events_hr_read on public.applicant_stage_events
  for select to authenticated
  using (public.has_org_capability(organization_id, 'hr.read'));
create policy applicant_interviews_hr_read on public.applicant_interviews
  for select to authenticated
  using (public.has_org_capability(organization_id, 'hr.read'));
create policy applicant_notes_hr_read on public.applicant_notes
  for select to authenticated
  using (public.has_org_capability(organization_id, 'hr.read'));

grant select on public.applicants, public.applicant_stage_events,
  public.applicant_interviews, public.applicant_notes to authenticated;

create or replace function public.list_applicants(
  p_organization_id uuid,
  p_stage text default null,
  p_search text default null,
  p_source text default null,
  p_sort text default 'applied_desc',
  p_page integer default 1,
  p_page_size integer default 20
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
  normalized_sort text := lower(btrim(coalesce(p_sort, 'applied_desc')));
  page_number integer := greatest(1, coalesce(p_page, 1));
  page_size integer := greatest(1, least(coalesce(p_page_size, 20), 100));
  total_rows integer;
  stage_counts jsonb;
  page_items jsonb;
begin
  if not public.has_org_capability(p_organization_id, 'hr.read') then
    raise exception using errcode = '42501', message = 'hr_read_required';
  end if;
  if normalized_stage is not null and normalized_stage not in ('New','Screening','Interview','Offer','Hired','Rejected','Archived') then
    raise exception using errcode = 'P0001', message = 'invalid_applicant_stage';
  end if;
  if normalized_sort not in ('applied_desc','applied_asc','name_asc','rating_desc') then normalized_sort := 'applied_desc'; end if;

  select jsonb_object_agg(stage_name, stage_count order by stage_order)
  into stage_counts
  from (
    select stages.stage_name, stages.stage_order, count(applicant.id)::integer stage_count
    from (values
      ('New',1),('Screening',2),('Interview',3),('Offer',4),
      ('Hired',5),('Rejected',6),('Archived',7)
    ) stages(stage_name, stage_order)
    left join public.applicants applicant
      on applicant.organization_id = p_organization_id
     and applicant.stage = stages.stage_name
     and applicant.deleted_at is null
    group by stages.stage_name, stages.stage_order
  ) counts;

  select count(*)::integer into total_rows
  from public.applicants applicant
  where applicant.organization_id = p_organization_id
    and applicant.deleted_at is null
    and (normalized_stage is null or applicant.stage = normalized_stage)
    and (normalized_source = '' or applicant.source = normalized_source)
    and (normalized_search = '' or concat_ws(' ', applicant.full_name, applicant.email_normalized, applicant.phone, applicant.position, applicant.area) ilike '%' || normalized_search || '%');

  select coalesce(jsonb_agg(item order by item_order), '[]'::jsonb) into page_items
  from (
    select jsonb_build_object(
      'id', applicant.id,
      'legacyRecordId', applicant.legacy_record_id,
      'fullName', applicant.full_name,
      'email', applicant.email_normalized,
      'phone', applicant.phone,
      'position', applicant.position,
      'stage', applicant.stage,
      'source', applicant.source,
      'appliedAt', applicant.applied_at,
      'area', applicant.area,
      'experience', applicant.experience,
      'rating', applicant.rating,
      'gameScore', applicant.game_score,
      'convertedEmployeeId', applicant.converted_employee_id,
      'version', applicant.version
    ) item,
    row_number() over (
      order by
        case when normalized_sort = 'name_asc' then lower(applicant.full_name) end asc,
        case when normalized_sort = 'rating_desc' then applicant.rating end desc nulls last,
        case when normalized_sort = 'applied_asc' then applicant.applied_at end asc,
        case when normalized_sort = 'applied_desc' then applicant.applied_at end desc,
        applicant.id
    ) item_order
    from public.applicants applicant
    where applicant.organization_id = p_organization_id
      and applicant.deleted_at is null
      and (normalized_stage is null or applicant.stage = normalized_stage)
      and (normalized_source = '' or applicant.source = normalized_source)
      and (normalized_search = '' or concat_ws(' ', applicant.full_name, applicant.email_normalized, applicant.phone, applicant.position, applicant.area) ilike '%' || normalized_search || '%')
    order by
      case when normalized_sort = 'name_asc' then lower(applicant.full_name) end asc,
      case when normalized_sort = 'rating_desc' then applicant.rating end desc nulls last,
      case when normalized_sort = 'applied_asc' then applicant.applied_at end asc,
      case when normalized_sort = 'applied_desc' then applicant.applied_at end desc,
      applicant.id
    limit page_size offset (page_number - 1) * page_size
  ) page;

  return jsonb_build_object(
    'ok', true,
    'items', page_items,
    'counts', coalesce(stage_counts, '{}'::jsonb),
    'total', total_rows,
    'page', page_number,
    'pageSize', page_size,
    'pages', greatest(1, ceil(total_rows::numeric / page_size)::integer)
  );
end;
$$;

create or replace function public.get_applicant_profile(
  p_organization_id uuid,
  p_legacy_record_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  applicant_row public.applicants%rowtype;
begin
  if not public.has_org_capability(p_organization_id, 'hr.read') then
    raise exception using errcode = '42501', message = 'hr_read_required';
  end if;
  select * into applicant_row from public.applicants applicant
  where applicant.organization_id = p_organization_id
    and applicant.legacy_record_id = p_legacy_record_id
    and applicant.deleted_at is null;
  if applicant_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  return jsonb_build_object(
    'ok', true,
    'applicant', jsonb_build_object(
      'id', applicant_row.id,
      'legacyRecordId', applicant_row.legacy_record_id,
      'fullName', applicant_row.full_name,
      'email', applicant_row.email_normalized,
      'phone', applicant_row.phone,
      'position', applicant_row.position,
      'stage', applicant_row.stage,
      'source', applicant_row.source,
      'appliedAt', applicant_row.applied_at,
      'area', applicant_row.area,
      'specialization', applicant_row.specialization,
      'experience', applicant_row.experience,
      'availableFrom', applicant_row.available_from,
      'currentSalary', applicant_row.current_salary,
      'expectedSalary', applicant_row.expected_salary,
      'workplaces', applicant_row.workplaces,
      'courses', applicant_row.courses,
      'cvLink', applicant_row.cv_url,
      'portfolioLink', applicant_row.portfolio_url,
      'rating', applicant_row.rating,
      'gameScore', applicant_row.game_score,
      'convertedEmployeeId', applicant_row.converted_employee_id,
      'applicationAnswers', applicant_row.application_answers,
      'attachments', applicant_row.attachments,
      'version', applicant_row.version
    ),
    'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', interview.id, 'scheduledAt', interview.scheduled_at,
        'durationMinutes', interview.duration_minutes, 'mode', interview.mode,
        'locationOrLink', interview.location_or_link, 'status', interview.status,
        'notes', interview.notes, 'createdAt', interview.created_at
      ) order by interview.scheduled_at desc)
      from public.applicant_interviews interview
      where interview.organization_id = p_organization_id and interview.applicant_id = applicant_row.id
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', note.id, 'note', note.note, 'createdAt', note.created_at,
        'createdBy', note.created_by
      ) order by note.created_at desc)
      from public.applicant_notes note
      where note.organization_id = p_organization_id and note.applicant_id = applicant_row.id
    ), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', event.id, 'fromStage', event.from_stage, 'toStage', event.to_stage,
        'note', event.note, 'actorUserId', event.actor_user_id,
        'occurredAt', event.occurred_at
      ) order by event.occurred_at desc)
      from public.applicant_stage_events event
      where event.organization_id = p_organization_id and event.applicant_id = applicant_row.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.change_applicant_stage(
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
  normalized_stage text := public.normalize_applicant_stage(p_stage);
  applicant_id_value uuid;
begin
  if not public.has_org_capability(p_organization_id, 'hr.manage') then
    raise exception using errcode = '42501', message = 'hr_manage_required';
  end if;
  if p_stage is null or normalized_stage <> btrim(p_stage) then
    raise exception using errcode = 'P0001', message = 'invalid_applicant_stage';
  end if;

  update public.records record
  set data = jsonb_set(jsonb_set(record.data, '{stage}', to_jsonb(normalized_stage), true), '{updatedAt}', to_jsonb(now()), true),
      updated_at = now()
  where record.organization_id = p_organization_id
    and record.id = p_legacy_record_id
    and record.coll = 'candidates'
    and record.deleted_at is null;
  if not found then raise exception using errcode = 'P0001', message = 'applicant_not_found'; end if;

  select applicant.id into applicant_id_value
  from public.applicants applicant
  where applicant.organization_id = p_organization_id and applicant.legacy_record_id = p_legacy_record_id;

  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into public.applicant_notes (organization_id, applicant_id, note, created_by)
    values (p_organization_id, applicant_id_value, left(btrim(p_note), 5000), auth.uid());
  end if;
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_context)
  values (p_organization_id, auth.uid(), 'APPLICANT_STAGE_CHANGED', 'applicant', applicant_id_value::text,
    jsonb_build_object('stage', normalized_stage, 'legacyRecordId', p_legacy_record_id));
  return public.get_applicant_profile(p_organization_id, p_legacy_record_id);
end;
$$;

create or replace function public.add_applicant_note(
  p_organization_id uuid,
  p_legacy_record_id text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare applicant_id_value uuid;
begin
  if not public.has_org_capability(p_organization_id, 'hr.manage') then
    raise exception using errcode = '42501', message = 'hr_manage_required';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) not between 1 and 5000 then
    raise exception using errcode = 'P0001', message = 'invalid_applicant_note';
  end if;
  select applicant.id into applicant_id_value from public.applicants applicant
  where applicant.organization_id = p_organization_id and applicant.legacy_record_id = p_legacy_record_id and applicant.deleted_at is null;
  if applicant_id_value is null then raise exception using errcode = 'P0001', message = 'applicant_not_found'; end if;
  insert into public.applicant_notes (organization_id, applicant_id, note, created_by)
  values (p_organization_id, applicant_id_value, btrim(p_note), auth.uid());
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_context)
  values (p_organization_id, auth.uid(), 'APPLICANT_NOTE_ADDED', 'applicant', applicant_id_value::text,
    jsonb_build_object('legacyRecordId', p_legacy_record_id));
  return public.get_applicant_profile(p_organization_id, p_legacy_record_id);
end;
$$;

create or replace function public.schedule_applicant_interview(
  p_organization_id uuid,
  p_legacy_record_id text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer default 45,
  p_mode text default 'Online',
  p_location_or_link text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  applicant_id_value uuid;
  interview_id_value uuid;
  normalized_mode text := initcap(lower(btrim(coalesce(p_mode, 'Online'))));
begin
  if not public.has_org_capability(p_organization_id, 'hr.manage') then
    raise exception using errcode = '42501', message = 'hr_manage_required';
  end if;
  if p_scheduled_at is null then raise exception using errcode = 'P0001', message = 'interview_time_required'; end if;
  if normalized_mode not in ('Online','Office','Phone') then raise exception using errcode = 'P0001', message = 'invalid_interview_mode'; end if;
  if coalesce(p_duration_minutes, 45) not between 10 and 480 then raise exception using errcode = 'P0001', message = 'invalid_interview_duration'; end if;
  select applicant.id into applicant_id_value from public.applicants applicant
  where applicant.organization_id = p_organization_id and applicant.legacy_record_id = p_legacy_record_id and applicant.deleted_at is null;
  if applicant_id_value is null then raise exception using errcode = 'P0001', message = 'applicant_not_found'; end if;

  insert into public.applicant_interviews (
    organization_id, applicant_id, scheduled_at, duration_minutes, mode,
    location_or_link, notes, created_by
  ) values (
    p_organization_id, applicant_id_value, p_scheduled_at,
    coalesce(p_duration_minutes, 45), normalized_mode,
    nullif(btrim(coalesce(p_location_or_link, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid()
  ) returning id into interview_id_value;

  if (select stage from public.applicants where id = applicant_id_value) in ('New','Screening') then
    update public.records record
    set data = jsonb_set(jsonb_set(record.data, '{stage}', '"Interview"'::jsonb, true), '{updatedAt}', to_jsonb(now()), true),
        updated_at = now()
    where record.organization_id = p_organization_id and record.id = p_legacy_record_id and record.coll = 'candidates';
  end if;
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_context)
  values (p_organization_id, auth.uid(), 'APPLICANT_INTERVIEW_SCHEDULED', 'applicant', applicant_id_value::text,
    jsonb_build_object('interviewId', interview_id_value, 'scheduledAt', p_scheduled_at, 'mode', normalized_mode));
  return public.get_applicant_profile(p_organization_id, p_legacy_record_id);
end;
$$;

revoke all on function public.normalize_applicant_stage(text) from public, anon;
revoke all on function public.sync_applicant_from_legacy_record() from public, anon, authenticated;
revoke all on function public.log_applicant_stage_event() from public, anon, authenticated;
revoke all on function public.list_applicants(uuid,text,text,text,text,integer,integer) from public, anon;
revoke all on function public.get_applicant_profile(uuid,text) from public, anon;
revoke all on function public.change_applicant_stage(uuid,text,text,text) from public, anon;
revoke all on function public.add_applicant_note(uuid,text,text) from public, anon;
revoke all on function public.schedule_applicant_interview(uuid,text,timestamptz,integer,text,text,text) from public, anon;
grant execute on function public.normalize_applicant_stage(text) to authenticated, service_role;
grant execute on function public.list_applicants(uuid,text,text,text,text,integer,integer) to authenticated, service_role;
grant execute on function public.get_applicant_profile(uuid,text) to authenticated, service_role;
grant execute on function public.change_applicant_stage(uuid,text,text,text) to authenticated, service_role;
grant execute on function public.add_applicant_note(uuid,text,text) to authenticated, service_role;
grant execute on function public.schedule_applicant_interview(uuid,text,timestamptz,integer,text,text,text) to authenticated, service_role;

insert into public.migration_audit (migration, note)
values (
  '20260825220000_recruitment_v2',
  'Backfilled legacy candidates into a tenant-scoped canonical applicant model with stage history, interviews, notes, paginated server search, authorized lifecycle commands, and zero legacy-row deletion.'
);

commit;

-- Rollback is forward-only: switch the application back to the legacy candidate
-- list, revoke the Recruitment V2 RPCs, and leave canonical rows/history intact.
