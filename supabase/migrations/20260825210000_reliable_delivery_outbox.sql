-- MAGNET OS V2 / M4: reliable, observable delivery outbox.
--
-- Internal browser email requests are authorized by the live Supabase JWT and
-- enqueue a durable message. Provider delivery happens server-side. Public
-- intake messages use the same queue. Every attempt is append-only and contains
-- only safe provider metadata/error categories, never credentials or bodies.

begin;

alter table public.outbox_messages
  add column if not exists max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  add column if not exists last_attempt_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists provider_status text,
  add column if not exists correlation_id uuid not null default gen_random_uuid();

alter table public.outbox_messages drop constraint if exists outbox_messages_status_check;
alter table public.outbox_messages add constraint outbox_messages_status_check
  check (status in ('PENDING','PROCESSING','ACCEPTED','DELIVERED','FAILED','SUPPRESSED','CANCELLED'));

create index if not exists outbox_org_status_time_idx
  on public.outbox_messages (organization_id, status, created_at desc);
create index if not exists outbox_correlation_idx
  on public.outbox_messages (correlation_id);

create table if not exists public.outbox_delivery_attempts (
  id bigint generated always as identity primary key,
  outbox_message_id uuid not null references public.outbox_messages(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  provider text not null check (char_length(provider) between 1 and 80),
  outcome text not null check (outcome in ('ACCEPTED','DELIVERED','FAILED','SUPPRESSED')),
  provider_message_id text,
  provider_status text,
  error_category text,
  safe_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  unique (outbox_message_id, attempt_number)
);

create index if not exists outbox_delivery_attempts_message_idx
  on public.outbox_delivery_attempts (outbox_message_id, occurred_at desc);
create index if not exists outbox_delivery_attempts_org_time_idx
  on public.outbox_delivery_attempts (organization_id, occurred_at desc);

drop trigger if exists outbox_delivery_attempts_append_only on public.outbox_delivery_attempts;
create trigger outbox_delivery_attempts_append_only
  before update or delete on public.outbox_delivery_attempts
  for each row execute function public.prevent_event_mutation();

alter table public.outbox_delivery_attempts enable row level security;
revoke all privileges on public.outbox_delivery_attempts from public, anon, authenticated;
grant select, insert on public.outbox_delivery_attempts to service_role;
grant usage, select on sequence public.outbox_delivery_attempts_id_seq to service_role;

create or replace function public.can_send_operational_email(
  p_organization_id uuid,
  p_purpose text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case upper(p_purpose)
    when 'TASK_ASSIGNMENT' then public.has_org_capability(p_organization_id, 'work.manage')
    when 'PAYSLIP' then public.has_org_capability(p_organization_id, 'finance.manage')
    when 'EMPLOYEE_REPORT' then public.has_org_capability(p_organization_id, 'reports.manage')
      or public.has_org_capability(p_organization_id, 'hr.manage')
    when 'USER_ADMIN' then public.has_org_capability(p_organization_id, 'members.manage')
    when 'DOCUMENT' then public.has_org_capability(p_organization_id, 'clients.manage')
      or public.has_org_capability(p_organization_id, 'finance.manage')
      or public.has_org_capability(p_organization_id, 'reports.manage')
    when 'NOTIFICATION' then public.has_org_capability(p_organization_id, 'work.manage')
      or public.has_org_capability(p_organization_id, 'approvals.manage')
      or public.has_org_capability(p_organization_id, 'hr.manage')
      or public.has_org_capability(p_organization_id, 'finance.manage')
    when 'SYSTEM_TEST' then public.has_org_capability(p_organization_id, 'organization.manage')
    else false
  end;
$$;

create or replace function public.enqueue_email_message(
  p_organization_id uuid,
  p_purpose text,
  p_recipients jsonb,
  p_subject text,
  p_html text,
  p_text text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid := p_organization_id;
  normalized_purpose text := upper(btrim(coalesce(p_purpose, '')));
  normalized_recipients jsonb;
  existing_idempotency public.idempotency_keys%rowtype;
  inserted_idempotency uuid;
  message_row public.outbox_messages%rowtype;
begin
  if target_organization_id is null then
    raise exception using errcode = 'P0001', message = 'active_organization_required';
  end if;
  if not exists (
    select 1
    from public.organization_members membership
    join public.organizations organization on organization.id = membership.organization_id
    join public.profiles profile on profile.id = membership.user_id
    where membership.organization_id = target_organization_id
    and membership.user_id = auth.uid()
    and membership.status = 'ACTIVE'
    and organization.status = 'ACTIVE'
    and organization.deleted_at is null
    and profile.identity_status = 'ACTIVE'
  ) then
    raise exception using errcode = 'P0001', message = 'active_membership_required';
  end if;
  if not public.can_send_operational_email(target_organization_id, normalized_purpose) then
    raise exception using errcode = '42501', message = 'email_capability_required';
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array'
      or jsonb_array_length(p_recipients) not between 1 and 10 then
    raise exception using errcode = 'P0001', message = 'invalid_recipients';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(p_recipients) as recipients(recipient)
    where char_length(recipients.recipient) > 320
      or recipients.recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_recipients';
  end if;
  if p_subject is null or char_length(btrim(p_subject)) not between 1 and 200
      or p_subject ~ E'[\r\n]' then
    raise exception using errcode = 'P0001', message = 'invalid_subject';
  end if;
  if coalesce(p_html, '') = '' and coalesce(p_text, '') = '' then
    raise exception using errcode = 'P0001', message = 'missing_message_body';
  end if;
  if char_length(coalesce(p_html, '')) > 150000 or char_length(coalesce(p_text, '')) > 150000 then
    raise exception using errcode = 'P0001', message = 'message_too_large';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  if p_request_hash is null or char_length(p_request_hash) not between 43 and 128 then
    raise exception using errcode = 'P0001', message = 'invalid_request_hash';
  end if;

  select jsonb_agg(lower(btrim(recipients.recipient)) order by lower(btrim(recipients.recipient)))
  into normalized_recipients
  from jsonb_array_elements_text(p_recipients) as recipients(recipient);

  insert into public.idempotency_keys (
    organization_id, actor_user_id, scope, key, request_hash, status, expires_at
  ) values (
    target_organization_id, auth.uid(), 'email:' || normalized_purpose,
    p_idempotency_key, p_request_hash, 'IN_PROGRESS', now() + interval '7 days'
  )
  on conflict (organization_id, scope, key) do nothing
  returning id into inserted_idempotency;

  if inserted_idempotency is null then
    select * into existing_idempotency
    from public.idempotency_keys idem
    where idem.organization_id = target_organization_id
      and idem.scope = 'email:' || normalized_purpose
      and idem.key = p_idempotency_key;
    if existing_idempotency.request_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    if existing_idempotency.status = 'COMPLETED' and existing_idempotency.response_body is not null then
      return existing_idempotency.response_body || jsonb_build_object('replayed', true);
    end if;
    raise exception using errcode = 'P0001', message = 'request_in_progress';
  end if;

  insert into public.outbox_messages (
    organization_id, kind, recipient_ref, payload, idempotency_key
  ) values (
    target_organization_id,
    'EMAIL_INTERNAL',
    'DIRECT_EMAIL',
    jsonb_build_object(
      'purpose', normalized_purpose,
      'to', normalized_recipients,
      'subject', btrim(p_subject),
      'html', nullif(p_html, ''),
      'text', nullif(p_text, ''),
      'actorUserId', auth.uid()
    ),
    p_idempotency_key
  )
  returning * into message_row;

  update public.idempotency_keys
  set status = 'COMPLETED', response_status = 202,
      response_body = jsonb_build_object(
        'ok', true,
        'id', message_row.id,
        'status', message_row.status,
        'correlationId', message_row.correlation_id,
        'replayed', false
      )
  where id = inserted_idempotency;

  insert into public.audit_events (
    organization_id, actor_user_id, action, entity_type, entity_id, safe_context
  ) values (
    target_organization_id, auth.uid(), 'EMAIL_QUEUED', 'outbox_message', message_row.id::text,
    jsonb_build_object('purpose', normalized_purpose, 'correlationId', message_row.correlation_id)
  );

  return jsonb_build_object(
    'ok', true,
    'id', message_row.id,
    'status', message_row.status,
    'correlationId', message_row.correlation_id,
    'replayed', false
  );
end;
$$;

create or replace function public.claim_outbox_messages(
  p_worker_id text,
  p_limit integer default 10,
  p_message_id uuid default null
)
returns setof public.outbox_messages
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 8 and 120 then
    raise exception using errcode = 'P0001', message = 'invalid_worker';
  end if;
  return query
  with claimable as (
    select message.id
    from public.outbox_messages message
    where (p_message_id is null or message.id = p_message_id)
      and message.attempt_count < message.max_attempts
      and (
        (message.status in ('PENDING','FAILED') and message.next_attempt_at <= now())
        or (message.status = 'PROCESSING' and message.locked_at < now() - interval '5 minutes')
      )
    order by message.next_attempt_at, message.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.outbox_messages message
  set status = 'PROCESSING', locked_at = now(), locked_by = p_worker_id,
      last_attempt_at = now(), attempt_count = message.attempt_count + 1
  from claimable
  where message.id = claimable.id
  returning message.*;
end;
$$;

create or replace function public.finish_outbox_message(
  p_message_id uuid,
  p_worker_id text,
  p_outcome text,
  p_provider text,
  p_provider_message_id text default null,
  p_provider_status text default null,
  p_error_category text default null,
  p_safe_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  message_row public.outbox_messages%rowtype;
  normalized_outcome text := upper(btrim(coalesce(p_outcome, '')));
  next_attempt timestamptz;
begin
  if normalized_outcome not in ('ACCEPTED','DELIVERED','FAILED','SUPPRESSED') then
    raise exception using errcode = 'P0001', message = 'invalid_delivery_outcome';
  end if;
  if p_provider is null or char_length(p_provider) not between 1 and 80 then
    raise exception using errcode = 'P0001', message = 'invalid_provider';
  end if;
  if p_safe_context is null or jsonb_typeof(p_safe_context) <> 'object' or pg_column_size(p_safe_context) > 20000 then
    raise exception using errcode = 'P0001', message = 'invalid_safe_context';
  end if;

  select * into message_row
  from public.outbox_messages message
  where message.id = p_message_id
    and message.status = 'PROCESSING'
    and message.locked_by = p_worker_id
  for update;
  if message_row.id is null then
    raise exception using errcode = 'P0001', message = 'outbox_lease_not_owned';
  end if;

  if normalized_outcome = 'FAILED' then
    next_attempt := case message_row.attempt_count
      when 1 then now() + interval '5 minutes'
      when 2 then now() + interval '30 minutes'
      when 3 then now() + interval '2 hours'
      when 4 then now() + interval '12 hours'
      else 'infinity'::timestamptz
    end;
  else
    next_attempt := message_row.next_attempt_at;
  end if;

  update public.outbox_messages
  set
    status = normalized_outcome,
    provider_message_id = nullif(p_provider_message_id, ''),
    provider_status = nullif(p_provider_status, ''),
    last_error_category = case when normalized_outcome = 'FAILED' then nullif(p_error_category, '') else null end,
    next_attempt_at = next_attempt,
    delivered_at = case when normalized_outcome = 'DELIVERED' then now() else delivered_at end,
    locked_at = null,
    locked_by = null
  where id = message_row.id;

  insert into public.outbox_delivery_attempts (
    outbox_message_id, organization_id, attempt_number, provider, outcome,
    provider_message_id, provider_status, error_category, safe_context
  ) values (
    message_row.id, message_row.organization_id, message_row.attempt_count,
    btrim(p_provider), normalized_outcome, nullif(p_provider_message_id, ''),
    nullif(p_provider_status, ''), nullif(p_error_category, ''), p_safe_context
  );

  return jsonb_build_object(
    'ok', true,
    'id', message_row.id,
    'status', normalized_outcome,
    'attemptCount', message_row.attempt_count,
    'nextAttemptAt', next_attempt,
    'correlationId', message_row.correlation_id
  );
end;
$$;

create or replace function public.get_outbox_delivery_status(p_message_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  message_row public.outbox_messages%rowtype;
begin
  select message.* into message_row
  from public.outbox_messages message
  where message.id = p_message_id
    and public.is_active_org_member(message.organization_id);
  if message_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object(
    'ok', true,
    'id', message_row.id,
    'status', message_row.status,
    'attemptCount', message_row.attempt_count,
    'maxAttempts', message_row.max_attempts,
    'providerStatus', message_row.provider_status,
    'lastErrorCategory', message_row.last_error_category,
    'createdAt', message_row.created_at,
    'lastAttemptAt', message_row.last_attempt_at,
    'deliveredAt', message_row.delivered_at,
    'nextAttemptAt', case when message_row.next_attempt_at = 'infinity'::timestamptz then null else message_row.next_attempt_at end,
    'correlationId', message_row.correlation_id
  );
end;
$$;

create or replace function public.retry_outbox_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  message_row public.outbox_messages%rowtype;
  purpose text;
begin
  select message.* into message_row
  from public.outbox_messages message
  where message.id = p_message_id
    and public.is_active_org_member(message.organization_id)
  for update;
  if message_row.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  purpose := coalesce(message_row.payload->>'purpose', 'NOTIFICATION');
  if message_row.kind = 'EMAIL_INTERNAL'
      and not public.can_send_operational_email(message_row.organization_id, purpose) then
    raise exception using errcode = '42501', message = 'email_capability_required';
  end if;
  if message_row.kind <> 'EMAIL_INTERNAL'
      and not (public.has_org_capability(message_row.organization_id, 'organization.manage')
        or public.has_org_capability(message_row.organization_id, 'members.manage')) then
    raise exception using errcode = '42501', message = 'delivery_retry_capability_required';
  end if;

  update public.outbox_messages
  set status = 'PENDING', max_attempts = greatest(max_attempts, attempt_count + 5), next_attempt_at = now(),
      locked_at = null, locked_by = null, last_error_category = null
  where id = message_row.id;

  insert into public.audit_events (
    organization_id, actor_user_id, action, entity_type, entity_id, safe_context
  ) values (
    message_row.organization_id, auth.uid(), 'OUTBOX_RETRY_REQUESTED',
    'outbox_message', message_row.id::text,
    jsonb_build_object('correlationId', message_row.correlation_id)
  );

  return jsonb_build_object('ok', true, 'id', message_row.id, 'status', 'PENDING');
end;
$$;

revoke all on function public.can_send_operational_email(uuid, text) from public, anon;
revoke all on function public.enqueue_email_message(uuid, text, jsonb, text, text, text, text, text) from public, anon;
revoke all on function public.get_outbox_delivery_status(uuid) from public, anon;
revoke all on function public.retry_outbox_message(uuid) from public, anon;
grant execute on function public.can_send_operational_email(uuid, text) to authenticated;
grant execute on function public.enqueue_email_message(uuid, text, jsonb, text, text, text, text, text) to authenticated;
grant execute on function public.get_outbox_delivery_status(uuid) to authenticated;
grant execute on function public.retry_outbox_message(uuid) to authenticated;

revoke all on function public.claim_outbox_messages(text, integer, uuid) from public, anon, authenticated;
revoke all on function public.finish_outbox_message(uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_outbox_messages(text, integer, uuid) to service_role;
grant execute on function public.finish_outbox_message(uuid, text, text, text, text, text, text, jsonb) to service_role;

insert into public.migration_audit (migration, note)
values (
  '20260825210000_reliable_delivery_outbox',
  'Added capability-authorized internal email enqueueing, leased provider processing, bounded retries, delivery status/retry RPCs, correlation IDs, and immutable delivery-attempt history.'
);

commit;

-- Rollback is forward-only: disable provider processing, then revoke enqueue /
-- retry RPCs. Preserve outbox and attempt history for incident review.
