#!/usr/bin/env node
'use strict';

// Live Recruitment V2 canary. It refuses Production and rolls back every
// synthetic applicant, note, interview, audit, and outbox record it creates.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROTECTED_PROJECT_REFS } = require('./project-safety');
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
if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
  console.error('Refused: explicit non-Production project ref required.');
  process.exit(2);
}
const project = jsonCli(['projects', 'list', '--output', 'json']).find((item) => item.ref === projectRef);
if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
  console.error('Refused: target is not healthy MAGNET OS STAGING.');
  process.exit(2);
}

const suffix = crypto.randomBytes(12).toString('hex');
const intakeKey = 'staging-recruitment/' + suffix;
const requestHash = crypto.createHash('sha256').update('recruitment-' + suffix).digest('base64url');
const fingerprint = crypto.createHash('sha256').update('fingerprint-' + suffix).digest('base64url');
const sql = `
begin;
do $test$
declare
  target_organization_id uuid;
  owner_user_id uuid;
  limited_user_id uuid;
  intake_result jsonb;
  list_result jsonb;
  profile_result jsonb;
  candidate_record_id text;
  applicant_id_value uuid;
  stage_event_count integer;
  interview_count integer;
  note_count integer;
  denied boolean := false;
begin
  select organization.id into target_organization_id
  from public.organizations organization
  where organization.slug = 'magnet' and organization.status = 'ACTIVE' and organization.deleted_at is null;
  if target_organization_id is null then raise exception 'missing Staging organization'; end if;

  select membership.user_id into owner_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id = membership.role_id
  join public.profiles profile on profile.id = membership.user_id
  join public.role_capabilities role_capability on role_capability.role_id = role.id
  join public.capabilities capability on capability.id = role_capability.capability_id and capability.key = 'hr.manage'
  where membership.organization_id = target_organization_id
    and membership.status = 'ACTIVE' and profile.identity_status = 'ACTIVE'
    and role.key in ('owner','admin','hr')
  limit 1;
  if owner_user_id is null then raise exception 'missing active Staging HR manager'; end if;

  intake_result := public.submit_public_intake(
    target_organization_id,
    'candidate',
    '{"fullName":"Synthetic Recruitment Canary","mobile":"+201000000000","email":"recruitment-canary@example.invalid","position":"QA Engineer","experience":"3-5 years","expectedSalary":"15000","source":"Website"}'::jsonb,
    '${intakeKey}', '${requestHash}', '${fingerprint}'
  );
  candidate_record_id := intake_result->>'id';
  select applicant.id into applicant_id_value
  from public.applicants applicant
  where applicant.organization_id = target_organization_id and applicant.legacy_record_id = candidate_record_id;
  if applicant_id_value is null then raise exception 'canonical applicant projection failed'; end if;
  if (select stage from public.applicants where id = applicant_id_value) <> 'New' then raise exception 'initial stage mismatch'; end if;
  if (select source from public.applicants where id = applicant_id_value) <> 'Website' then raise exception 'source mismatch'; end if;

  perform set_config('request.jwt.claim.sub', owner_user_id::text, true);
  list_result := public.list_applicants(target_organization_id, 'New', 'Synthetic Recruitment Canary', 'Website', 'applied_desc', 1, 20);
  if coalesce((list_result->>'total')::integer, 0) <> 1 then raise exception 'authorized search/pagination failed'; end if;
  if list_result->'items'->0->>'legacyRecordId' <> candidate_record_id then raise exception 'list item mismatch'; end if;

  profile_result := public.get_applicant_profile(target_organization_id, candidate_record_id);
  if coalesce((profile_result->>'ok')::boolean, false) is not true then raise exception 'profile load failed'; end if;
  if profile_result->'applicant'->>'expectedSalary' <> '15000.00' then raise exception 'salary projection mismatch'; end if;

  perform public.add_applicant_note(target_organization_id, candidate_record_id, 'Synthetic internal note');
  perform public.schedule_applicant_interview(target_organization_id, candidate_record_id, now() + interval '2 days', 45, 'Online', 'https://example.invalid/interview', 'Synthetic interview');
  perform public.change_applicant_stage(target_organization_id, candidate_record_id, 'Offer', 'Synthetic offer note');

  if (select stage from public.applicants where id = applicant_id_value) <> 'Offer' then raise exception 'stage command failed'; end if;
  select count(*) into stage_event_count from public.applicant_stage_events where applicant_id = applicant_id_value;
  select count(*) into interview_count from public.applicant_interviews where applicant_id = applicant_id_value;
  select count(*) into note_count from public.applicant_notes where applicant_id = applicant_id_value;
  if stage_event_count <> 3 then raise exception 'stage history mismatch: %', stage_event_count; end if;
  if interview_count <> 1 then raise exception 'interview history mismatch'; end if;
  if note_count <> 2 then raise exception 'internal note history mismatch'; end if;

  if has_function_privilege('anon', 'public.list_applicants(uuid,text,text,text,text,integer,integer)', 'EXECUTE') then raise exception 'anon list execute leak'; end if;
  if has_function_privilege('anon', 'public.get_applicant_profile(uuid,text)', 'EXECUTE') then raise exception 'anon profile execute leak'; end if;
  if has_function_privilege('anon', 'public.change_applicant_stage(uuid,text,text,text)', 'EXECUTE') then raise exception 'anon stage execute leak'; end if;

  select membership.user_id into limited_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id = membership.role_id
  join public.profiles profile on profile.id = membership.user_id
  where membership.organization_id = target_organization_id
    and membership.status = 'ACTIVE' and profile.identity_status = 'ACTIVE'
    and role.key in ('content_creator','designer','client')
  limit 1;
  if limited_user_id is null then raise exception 'missing limited Staging member'; end if;
  perform set_config('request.jwt.claim.sub', limited_user_id::text, true);
  begin
    perform public.list_applicants(target_organization_id, null, null, null, 'applied_desc', 1, 20);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'limited role could read recruitment'; end if;
end $test$;
rollback;
`;

try {
  cli(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  process.stdout.write('Recruitment V2 Staging E2E: 20 passed, 0 failed. Transaction rolled back.\n');
} catch (error) {
  console.error('Recruitment V2 Staging E2E failed: ' + safe(error.message || error));
  process.exit(1);
}
