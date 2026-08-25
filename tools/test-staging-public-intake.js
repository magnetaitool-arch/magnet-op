#!/usr/bin/env node
'use strict';

// Live Staging database test for transactional website intake. All mutations run
// inside one transaction and are rolled back, including immutable audit rows.
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

const args = argsOf(process.argv);
const projectRef = String(args['project-ref'] || '').trim();
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
const hash = crypto.createHash('sha256').update('request-' + suffix).digest('base64url');
const fingerprint = crypto.createHash('sha256').update('fingerprint-' + suffix).digest('base64url');
const key = 'staging-public-intake/' + suffix;
const sql = `
begin;
do $$
declare
  target_organization_id uuid;
  first_result jsonb;
  replay_result jsonb;
  target_entity_id text;
  candidate_count integer;
  notification_count integer;
  outbox_count integer;
  audit_count integer;
begin
  select id into target_organization_id
  from public.organizations
  where slug = 'magnet' and status = 'ACTIVE' and deleted_at is null;
  if target_organization_id is null then raise exception 'missing staging organization'; end if;

  first_result := public.submit_public_intake(
    target_organization_id,
    'candidate',
    '{"fullName":"Synthetic Staging Candidate","mobile":"+201000000000","email":"candidate@example.invalid","position":"QA"}'::jsonb,
    '${key}', '${hash}', '${fingerprint}'
  );
  replay_result := public.submit_public_intake(
    target_organization_id,
    'candidate',
    '{"fullName":"Synthetic Staging Candidate","mobile":"+201000000000","email":"candidate@example.invalid","position":"QA"}'::jsonb,
    '${key}', '${hash}', '${fingerprint}'
  );
  target_entity_id := first_result->>'id';

  if coalesce((first_result->>'ok')::boolean, false) is not true then raise exception 'first intake failed'; end if;
  if replay_result->>'id' <> target_entity_id or coalesce((replay_result->>'replayed')::boolean, false) is not true then raise exception 'idempotent replay failed'; end if;

  select count(*) into candidate_count from public.records where id = target_entity_id and coll = 'candidates' and organization_id = target_organization_id;
  select count(*) into notification_count from public.records where coll = 'notifications' and data->>'entityId' = target_entity_id and organization_id = target_organization_id;
  select count(*) into outbox_count from public.outbox_messages where organization_id = target_organization_id and idempotency_key like '${key}:%';
  select count(*) into audit_count from public.audit_events where organization_id = target_organization_id and entity_id = target_entity_id and action = 'PUBLIC_APPLICANT_CREATED';

  if candidate_count <> 1 then raise exception 'candidate count mismatch'; end if;
  if notification_count <> 1 then raise exception 'notification count mismatch'; end if;
  if outbox_count <> 2 then raise exception 'outbox count mismatch'; end if;
  if audit_count <> 1 then raise exception 'audit count mismatch'; end if;

  if has_function_privilege('anon', 'public.submit_public_intake(uuid,text,jsonb,text,text,text)', 'EXECUTE') then raise exception 'anon execute leak'; end if;
  if has_function_privilege('authenticated', 'public.submit_public_intake(uuid,text,jsonb,text,text,text)', 'EXECUTE') then raise exception 'authenticated execute leak'; end if;
end $$;
rollback;
`;

try {
  cli(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  process.stdout.write('Public intake Staging E2E: 10 passed, 0 failed. Transaction rolled back.\n');
} catch (error) {
  console.error('Public intake Staging E2E failed: ' + safe(error.message || error));
  process.exit(1);
}
