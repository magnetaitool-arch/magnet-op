#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';

function parseArgs(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const at = raw.indexOf('=');
    result[raw.slice(2, at < 0 ? undefined : at)] = at < 0 ? true : raw.slice(at + 1);
  }
  return result;
}

function safe(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[REDACTED_EMAIL]')
    .slice(-6000);
}

function cli(args) {
  const result = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) throw new Error(safe(result.stderr || result.stdout));
  return String(result.stdout || '');
}

function jsonCli(args) {
  const output = cli(args);
  const arrayAt = output.indexOf('['); const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

const projectRef = String(parseArgs(process.argv)['project-ref'] || '').trim();
if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
  console.error('Refused: explicit non-Production project ref required.');
  process.exit(2);
}

const project = jsonCli(['projects', 'list', '--output', 'json']).find((item) => item.ref === projectRef);
if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
  console.error('Refused: target is not healthy MAGNET OS STAGING.');
  process.exit(2);
}

const sql = `
begin;
do $test$
declare
  org_id uuid;
  owner_id uuid;
  limited_id uuid;
  snapshot jsonb;
  denied boolean := false;
  serialized text;
begin
  select id into org_id from public.organizations where slug='magnet' and status='ACTIVE' and deleted_at is null limit 1;
  select membership.user_id into owner_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id where membership.organization_id=org_id and membership.status='ACTIVE' and role.key='owner' limit 1;
  select membership.user_id into limited_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id where membership.organization_id=org_id and membership.status='ACTIVE' and role.key in ('content_creator','designer','client') limit 1;
  if org_id is null or owner_id is null or limited_id is null then raise exception 'missing staging health canary membership'; end if;
  if has_function_privilege('anon','public.system_health_snapshot_v2(uuid)','EXECUTE') then raise exception 'anonymous health RPC access'; end if;

  perform set_config('request.jwt.claim.sub',limited_id::text,true);
  begin perform public.system_health_snapshot_v2(org_id);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'limited member received health snapshot'; end if;

  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  snapshot:=public.system_health_snapshot_v2(org_id);
  if coalesce((snapshot->>'ok')::boolean,false) is not true then raise exception 'owner health snapshot failed'; end if;
  if snapshot#>>'{database,status}'<>'HEALTHY' then raise exception 'database status missing'; end if;
  if (snapshot#>>'{database,businessRecords}')::integer<1 then raise exception 'business record aggregate missing'; end if;
  if snapshot->'auth' is null or snapshot->'storage' is null or snapshot->'outbox' is null or snapshot->'jobs' is null then raise exception 'health domain missing'; end if;
  serialized:=snapshot::text;
  if serialized ~* 'recipient|payload|object.name|service_role|access_token|refresh_token|password|@[a-z0-9]' then raise exception 'unsafe health payload'; end if;
end $test$;
rollback;`;

try {
  cli(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  process.stdout.write('System Health V2 Staging E2E: 9 passed, 0 failed. Read-only transaction rolled back.\n');
} catch (error) {
  console.error('System Health V2 Staging E2E failed: ' + safe(error.message || error));
  process.exit(1);
}
