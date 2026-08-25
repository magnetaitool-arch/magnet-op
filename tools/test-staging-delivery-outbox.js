#!/usr/bin/env node
'use strict';

// Live database canary for the reliable delivery outbox. It refuses Production
// and runs every mutation inside one transaction that is rolled back, including
// append-only audit and delivery-attempt rows.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';

function argsOf(argv) {
  const output = {};
  for (const item of argv.slice(2)) {
    if (!item.startsWith('--')) continue;
    const at = item.indexOf('=');
    output[item.slice(2, at < 0 ? undefined : at)] = at < 0 ? true : item.slice(at + 1);
  }
  return output;
}

function safe(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .slice(-3000);
}

function cli(args) {
  const result = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) throw new Error(safe(result.stderr || result.stdout));
  return result.stdout;
}

function jsonCli(args) {
  const output = cli(args);
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

const projectRef = String(argsOf(process.argv)['project-ref'] || '').trim();
if (!/^[a-z]{20}$/.test(projectRef) || projectRef === PRODUCTION_REF) {
  console.error('Refused: explicit non-Production project ref required.');
  process.exit(2);
}
const project = jsonCli(['projects', 'list', '--output', 'json']).find((item) => item.ref === projectRef);
if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
  console.error('Refused: target is not healthy MAGNET OS STAGING.');
  process.exit(2);
}

const suffix = crypto.randomBytes(12).toString('hex');
const requestHash = crypto.createHash('sha256').update('delivery-' + suffix).digest('base64url');
const idempotencyKey = 'staging-delivery/' + suffix;
const workerId = 'staging-worker-' + suffix;
const sql = `
begin;
do $test$
declare
  target_organization_id uuid;
  owner_user_id uuid;
  limited_user_id uuid;
  first_result jsonb;
  replay_result jsonb;
  finished_result jsonb;
  retry_result jsonb;
  status_result jsonb;
  message_id uuid;
  claimed_message public.outbox_messages%rowtype;
  attempt_rows integer;
  denied boolean := false;
begin
  select membership.organization_id, membership.user_id
  into target_organization_id, owner_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id = membership.role_id
  join public.profiles profile on profile.id = membership.user_id
  join public.organizations organization on organization.id = membership.organization_id
  where organization.slug = 'magnet'
    and organization.status = 'ACTIVE'
    and membership.status = 'ACTIVE'
    and profile.identity_status = 'ACTIVE'
    and role.key = 'owner'
  limit 1;
  if owner_user_id is null then raise exception 'missing active Staging owner'; end if;

  perform set_config('request.jwt.claim.sub', owner_user_id::text, true);
  first_result := public.enqueue_email_message(
    target_organization_id,
    'SYSTEM_TEST',
    '["delivery-canary@example.invalid"]'::jsonb,
    'MAGNET OS Staging delivery canary',
    null,
    'Synthetic body',
    '${idempotencyKey}',
    '${requestHash}'
  );
  replay_result := public.enqueue_email_message(
    target_organization_id,
    'SYSTEM_TEST',
    '["delivery-canary@example.invalid"]'::jsonb,
    'MAGNET OS Staging delivery canary',
    null,
    'Synthetic body',
    '${idempotencyKey}',
    '${requestHash}'
  );
  message_id := (first_result->>'id')::uuid;
  if message_id is null or first_result->>'status' <> 'PENDING' then raise exception 'enqueue failed'; end if;
  if replay_result->>'id' <> message_id::text or coalesce((replay_result->>'replayed')::boolean, false) is not true then raise exception 'idempotent replay failed'; end if;

  select * into claimed_message
  from public.claim_outbox_messages('${workerId}', 1, message_id);
  if claimed_message.id <> message_id or claimed_message.attempt_count <> 1 or claimed_message.status <> 'PROCESSING' then raise exception 'first claim failed'; end if;

  finished_result := public.finish_outbox_message(
    message_id, '${workerId}', 'FAILED', 'resend', null, 'not_configured',
    'CONFIGURATION_MISSING', '{"httpStatus":503}'::jsonb
  );
  if finished_result->>'status' <> 'FAILED' then raise exception 'failure was not persisted'; end if;
  status_result := public.get_outbox_delivery_status(message_id);
  if status_result->>'status' <> 'FAILED' or status_result->>'lastErrorCategory' <> 'CONFIGURATION_MISSING' then raise exception 'observable failure state missing'; end if;

  retry_result := public.retry_outbox_message(message_id);
  if retry_result->>'status' <> 'PENDING' then raise exception 'retry command failed'; end if;
  select * into claimed_message
  from public.claim_outbox_messages('${workerId}-retry', 1, message_id);
  if claimed_message.attempt_count <> 2 then raise exception 'retry attempt number mismatch'; end if;
  finished_result := public.finish_outbox_message(
    message_id, '${workerId}-retry', 'ACCEPTED', 'resend', 'synthetic-provider-id',
    'accepted', null, '{}'::jsonb
  );
  if finished_result->>'status' <> 'ACCEPTED' then raise exception 'provider acceptance was conflated or lost'; end if;

  select count(*) into attempt_rows
  from public.outbox_delivery_attempts where outbox_message_id = message_id;
  if attempt_rows <> 2 then raise exception 'delivery attempt history mismatch'; end if;

  select membership.user_id into limited_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id = membership.role_id
  join public.profiles profile on profile.id = membership.user_id
  where membership.organization_id = target_organization_id
    and membership.status = 'ACTIVE'
    and profile.identity_status = 'ACTIVE'
    and role.key in ('content_creator','designer','client')
  limit 1;
  if limited_user_id is null then raise exception 'missing limited-role Staging member'; end if;
  perform set_config('request.jwt.claim.sub', limited_user_id::text, true);
  begin
    perform public.enqueue_email_message(
      target_organization_id, 'SYSTEM_TEST', '["blocked@example.invalid"]'::jsonb,
      'Blocked canary', null, 'Blocked body', '${idempotencyKey}-blocked', '${requestHash}'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then raise exception 'limited role could enqueue SYSTEM_TEST'; end if;

  if has_function_privilege('anon', 'public.enqueue_email_message(uuid,text,jsonb,text,text,text,text,text)', 'EXECUTE') then raise exception 'anon enqueue grant leak'; end if;
  if not has_function_privilege('authenticated', 'public.enqueue_email_message(uuid,text,jsonb,text,text,text,text,text)', 'EXECUTE') then raise exception 'authenticated enqueue grant missing'; end if;
  if has_function_privilege('authenticated', 'public.claim_outbox_messages(text,integer,uuid)', 'EXECUTE') then raise exception 'browser worker grant leak'; end if;
  if has_function_privilege('authenticated', 'public.finish_outbox_message(uuid,text,text,text,text,text,text,jsonb)', 'EXECUTE') then raise exception 'browser finish grant leak'; end if;
end $test$;
rollback;
`;

try {
  cli(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  process.stdout.write('Delivery outbox Staging E2E: 18 passed, 0 failed. Transaction rolled back.\n');
} catch (error) {
  console.error('Delivery outbox Staging E2E failed: ' + safe(error.message || error));
  process.exit(1);
}
