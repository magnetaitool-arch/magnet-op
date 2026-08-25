-- MAGNET OS V2 / M3: transactional, tenant-safe public recruitment and sales intake.
--
-- Public browsers never receive database credentials. The Vercel/Netlify route
-- validates and minimizes the payload, then calls this service-role-only command.
-- The command atomically creates the canonical business record, in-app
-- notification, immutable audit event, idempotency result, and durable email /
-- WhatsApp outbox messages. Only a one-way request fingerprint is retained.

begin;

create table if not exists public.public_intake_rate_limits (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_kind text not null check (intake_kind in ('candidate', 'lead')),
  fingerprint_hash text not null check (char_length(fingerprint_hash) between 43 and 128),
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, intake_kind, fingerprint_hash)
);

create index if not exists public_intake_rate_limits_window_idx
  on public.public_intake_rate_limits (window_started_at);

alter table public.public_intake_rate_limits enable row level security;
revoke all privileges on public.public_intake_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.public_intake_rate_limits to service_role;

create or replace function public.submit_public_intake(
  p_organization_id uuid,
  p_intake_kind text,
  p_payload jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  idempotency_row public.idempotency_keys%rowtype;
  inserted_idempotency uuid;
  rate_count integer;
  entity_id text;
  notification_id text;
  created_at timestamptz := now();
  canonical_data jsonb;
  response_payload jsonb;
  notification_role text;
  notification_title text;
  notification_message text;
  entity_collection text;
  recipient_prefix text;
  safe_delivery_fields jsonb;
begin
  if not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.status = 'ACTIVE'
      and organization.deleted_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'organization_unavailable';
  end if;

  if p_intake_kind not in ('candidate', 'lead') then
    raise exception using errcode = 'P0001', message = 'invalid_intake_kind';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 100000 then
    raise exception using errcode = 'P0001', message = 'invalid_payload';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  if p_request_hash is null or char_length(p_request_hash) not between 43 and 128 then
    raise exception using errcode = 'P0001', message = 'invalid_request_hash';
  end if;
  if p_fingerprint_hash is null or char_length(p_fingerprint_hash) not between 43 and 128 then
    raise exception using errcode = 'P0001', message = 'invalid_fingerprint_hash';
  end if;

  insert into public.idempotency_keys (
    organization_id, scope, key, request_hash, status, expires_at
  ) values (
    p_organization_id,
    'public_intake:' || p_intake_kind,
    p_idempotency_key,
    p_request_hash,
    'IN_PROGRESS',
    created_at + interval '24 hours'
  )
  on conflict (organization_id, scope, key) do nothing
  returning id into inserted_idempotency;

  if inserted_idempotency is null then
    select * into idempotency_row
    from public.idempotency_keys idem
    where idem.organization_id = p_organization_id
      and idem.scope = 'public_intake:' || p_intake_kind
      and idem.key = p_idempotency_key;

    if idempotency_row.request_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    if idempotency_row.status = 'COMPLETED' and idempotency_row.response_body is not null then
      return idempotency_row.response_body || jsonb_build_object('replayed', true);
    end if;
    raise exception using errcode = 'P0001', message = 'request_in_progress';
  end if;

  insert into public.public_intake_rate_limits (
    organization_id, intake_kind, fingerprint_hash, window_started_at, request_count, updated_at
  ) values (
    p_organization_id, p_intake_kind, p_fingerprint_hash, created_at, 1, created_at
  )
  on conflict (organization_id, intake_kind, fingerprint_hash) do update
  set
    window_started_at = case
      when public.public_intake_rate_limits.window_started_at <= created_at - interval '10 minutes'
        then created_at
      else public.public_intake_rate_limits.window_started_at
    end,
    request_count = case
      when public.public_intake_rate_limits.window_started_at <= created_at - interval '10 minutes'
        then 1
      else public.public_intake_rate_limits.request_count + 1
    end,
    updated_at = created_at
  returning request_count into rate_count;

  if rate_count > 10 then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  if p_intake_kind = 'candidate' then
    entity_collection := 'candidates';
    entity_id := 'can-' || replace(gen_random_uuid()::text, '-', '');
    notification_role := 'HR';
    notification_title := 'New job application';
    notification_message := coalesce(nullif(p_payload->>'fullName', ''), 'A candidate')
      || ' applied for ' || coalesce(nullif(p_payload->>'position', ''), 'a role');
    recipient_prefix := 'HR';
    canonical_data := p_payload || jsonb_build_object(
      'id', entity_id,
      'source', 'Website',
      'stage', 'New',
      'rating', 0,
      'appliedAt', created_at,
      'createdAt', created_at,
      'updatedAt', created_at
    );
    safe_delivery_fields := jsonb_build_object(
      'name', p_payload->>'fullName',
      'position', p_payload->>'position',
      'phone', p_payload->>'mobile',
      'experience', p_payload->>'experience'
    );
  else
    entity_collection := 'leads';
    entity_id := 'lea-' || replace(gen_random_uuid()::text, '-', '');
    notification_role := 'Sales';
    notification_title := 'New website lead';
    notification_message := coalesce(nullif(p_payload->>'name', ''), nullif(p_payload->>'company', ''), 'A lead')
      || case when nullif(p_payload->>'serviceInterest', '') is not null
        then ' — ' || (p_payload->>'serviceInterest') else '' end;
    recipient_prefix := 'SALES';
    canonical_data := p_payload || jsonb_build_object(
      'id', entity_id,
      'name', coalesce(nullif(p_payload->>'name', ''), p_payload->>'company'),
      'source', 'Website',
      'status', 'New Lead',
      'brand', coalesce(nullif(p_payload->>'brand', ''), 'Magnet'),
      'createdAt', created_at,
      'updatedAt', created_at
    );
    safe_delivery_fields := jsonb_build_object(
      'name', p_payload->>'name',
      'company', p_payload->>'company',
      'phone', p_payload->>'phone',
      'service', p_payload->>'serviceInterest',
      'message', p_payload->>'message'
    );
  end if;

  notification_id := 'nt-' || replace(gen_random_uuid()::text, '-', '');

  insert into public.records (id, coll, data, organization_id)
  values (entity_id, entity_collection, canonical_data, p_organization_id);

  insert into public.records (id, coll, data, organization_id)
  values (
    notification_id,
    'notifications',
    jsonb_build_object(
      'id', notification_id,
      'userId', null,
      'role', notification_role,
      'title', notification_title,
      'message', notification_message,
      'entityType', entity_collection,
      'entityId', entity_id,
      'read', false,
      'createdAt', created_at
    ),
    p_organization_id
  );

  insert into public.audit_events (
    organization_id, action, entity_type, entity_id, after_data, safe_context
  ) values (
    p_organization_id,
    case when p_intake_kind = 'candidate' then 'PUBLIC_APPLICANT_CREATED' else 'PUBLIC_LEAD_CREATED' end,
    entity_collection,
    entity_id,
    jsonb_build_object('source', 'Website', 'status', canonical_data->>'status', 'stage', canonical_data->>'stage'),
    jsonb_build_object('channel', 'PUBLIC_FORM', 'request_hash', p_request_hash)
  );

  insert into public.outbox_messages (
    organization_id, kind, recipient_ref, payload, idempotency_key
  ) values
  (
    p_organization_id,
    'EMAIL_PUBLIC_INTAKE',
    recipient_prefix || '_EMAIL',
    jsonb_build_object(
      'entityType', entity_collection,
      'entityId', entity_id,
      'title', notification_title,
      'message', notification_message,
      'submittedAt', created_at,
      'deepLinkPath', '/?open=' || entity_collection || '&id=' || entity_id,
      'fields', safe_delivery_fields
    ),
    p_idempotency_key || ':email'
  ),
  (
    p_organization_id,
    'WHATSAPP_PUBLIC_INTAKE',
    recipient_prefix || '_WHATSAPP',
    jsonb_build_object(
      'entityType', entity_collection,
      'entityId', entity_id,
      'title', notification_title,
      'message', notification_message,
      'submittedAt', created_at,
      'deepLinkPath', '/?open=' || entity_collection || '&id=' || entity_id,
      'fields', safe_delivery_fields
    ),
    p_idempotency_key || ':whatsapp'
  );

  response_payload := jsonb_build_object(
    'ok', true,
    'id', entity_id,
    'type', p_intake_kind,
    'replayed', false,
    'notificationsQueued', true
  );

  update public.idempotency_keys
  set status = 'COMPLETED', response_status = 200, response_body = response_payload
  where id = inserted_idempotency;

  return response_payload;
end;
$$;

revoke all on function public.submit_public_intake(uuid, text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_public_intake(uuid, text, jsonb, text, text, text)
  to service_role;

insert into public.migration_audit (migration, note)
values (
  '20260825203000_transactional_public_intake',
  'Added service-only transactional website intake with tenant stamping, idempotency, hashed rate limiting, canonical records, notifications, immutable audit events, and durable email/WhatsApp outbox messages.'
);

commit;

-- Rollback is forward-only. Disable the website route first, then revoke the RPC.
-- Existing canonical applicants/leads and audit history must never be deleted.
