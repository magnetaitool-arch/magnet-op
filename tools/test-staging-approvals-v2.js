#!/usr/bin/env node
'use strict';

// Transactional live canary for MAGNET OS STAGING only. It exercises the
// server-authoritative approval command with real restored memberships and
// rolls back every synthetic record, notification, event, and audit row.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
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
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) throw new Error(safe(result.stderr || result.stdout));
  return String(result.stdout || '');
}

function jsonCli(args) {
  const output = cli(args);
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

const projectRef = String(parseArgs(process.argv)['project-ref'] || '').trim();
if (!/^[a-z]{20}$/.test(projectRef) || projectRef === PRODUCTION_REF) {
  console.error('Refused: explicit non-Production project ref required.');
  process.exit(2);
}

const project = jsonCli(['projects', 'list', '--output', 'json']).find((item) => item.ref === projectRef);
if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
  console.error('Refused: target is not healthy MAGNET OS STAGING.');
  process.exit(2);
}

const suffix = crypto.randomBytes(8).toString('hex');
const sql = `
begin;
do $test$
declare
  org_id uuid;
  owner_id uuid;
  finance_id uuid;
  worker_id uuid;
  worker_membership_id uuid;
  hr_role_id uuid;
  employee_id text;
  client_id text;
  project_id text;
  deliverable_id text := 'qa-approval-dlv-${suffix}';
  revision_deliverable_id text := 'qa-approval-revision-dlv-${suffix}';
  invoice_id text := 'qa-approval-inv-${suffix}';
  request_record_id text := 'qa-approval-req-${suffix}';
  lateness_request_id text := 'qa-approval-late-${suffix}';
  result jsonb;
  denied boolean := false;
  stale boolean := false;
begin
  select id into org_id from public.organizations where slug='magnet' and status='ACTIVE' and deleted_at is null limit 1;
  select membership.user_id into owner_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id where membership.organization_id=org_id and membership.status='ACTIVE' and role.key='owner' limit 1;
  select membership.user_id into finance_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id where membership.organization_id=org_id and membership.status='ACTIVE' and role.key='finance' limit 1;
  select id into hr_role_id from public.organization_roles where organization_id=org_id and key='hr' limit 1;
  select membership.id,membership.user_id,coalesce(profile.employee_id,link.employee_record_id) into worker_membership_id,worker_id,employee_id
  from public.organization_members membership
  join public.organization_roles role on role.id=membership.role_id
  join public.profiles profile on profile.id=membership.user_id
  left join public.legacy_identity_links link on link.auth_user_id=membership.user_id and link.link_status='CONFIRMED'
  where membership.organization_id=org_id and membership.status='ACTIVE' and role.key in ('content_creator','designer')
    and coalesce(profile.employee_id,link.employee_record_id) is not null limit 1;
  select id into client_id from public.records where organization_id=org_id and coll='clients' and deleted_at is null limit 1;
  select id into project_id from public.records where organization_id=org_id and coll='projects' and deleted_at is null and data->>'clientId'=client_id limit 1;
  if org_id is null or owner_id is null or finance_id is null or worker_id is null or employee_id is null or client_id is null or project_id is null or worker_membership_id is null or hr_role_id is null then
    raise exception 'missing staging approval canary membership';
  end if;
  if has_function_privilege('anon','public.transition_approval_v2(uuid,text,text,text,text,text)','EXECUTE') then
    raise exception 'anonymous approval RPC access';
  end if;

  insert into public.records(id,coll,data,organization_id,created_at,updated_at)
  values(deliverable_id,'deliverables',jsonb_build_object('id',deliverable_id,'title','Synthetic approval deliverable','status','Client Review','createdBy',worker_id::text),org_id,now(),now());

  perform set_config('request.jwt.claim.sub',worker_id::text,true);
  begin
    perform public.transition_approval_v2(org_id,'deliverables',deliverable_id,'Client Review','APPROVE',null);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'limited worker approved a deliverable'; end if;

  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  result:=public.transition_approval_v2(org_id,'deliverables',deliverable_id,'Client Review','APPROVE','Looks good');
  if coalesce((result->>'ok')::boolean,false) is not true or result->>'status'<>'Approved' then raise exception 'owner approval failed'; end if;
  if (select data->>'status' from public.records where id=deliverable_id)<>'Approved' then raise exception 'deliverable state not persisted'; end if;
  begin
    perform public.transition_approval_v2(org_id,'deliverables',deliverable_id,'Client Review','APPROVE',null);
  exception when serialization_failure then stale:=true; end;
  if not stale then raise exception 'stale approval was accepted'; end if;

  insert into public.records(id,coll,data,organization_id,created_at,updated_at)
  values(revision_deliverable_id,'deliverables',jsonb_build_object(
    'id',revision_deliverable_id,'title','Synthetic revision deliverable','status','Client Review',
    'version',2,'clientId',client_id,'projectId',project_id,'assignedTo',employee_id,'createdBy',worker_id::text
  ),org_id,now(),now());
  result:=public.transition_approval_v2(org_id,'deliverables',revision_deliverable_id,'Client Review','REQUEST_CHANGES','Fix the safe canary');
  if result->>'status'<>'Revision Requested' then raise exception 'deliverable revision request failed'; end if;
  if not exists(select 1 from public.records where organization_id=org_id and coll='revisions' and data->>'deliverableId'=revision_deliverable_id and data->>'note'='Fix the safe canary') then
    raise exception 'revision projection missing';
  end if;

  insert into public.records(id,coll,data,organization_id,created_at,updated_at)
  values(invoice_id,'invoices',jsonb_build_object('id',invoice_id,'invoiceNumber','QA-${suffix}','clientId',client_id,'projectId',project_id,'issueDate',current_date::text,'dueDate',(current_date+7)::text,'amount',1,'status','Pending Internal Approval','createdBy',worker_id::text),org_id,now(),now());
  perform set_config('request.jwt.claim.sub',finance_id::text,true);
  result:=public.transition_approval_v2(org_id,'invoices',invoice_id,'Pending Internal Approval','APPROVE',null);
  if result->>'status'<>'Approved Internally' then raise exception 'finance invoice approval failed'; end if;

  insert into public.records(id,coll,data,organization_id,created_at,updated_at)
  values(request_record_id,'approvalRequests',jsonb_build_object(
    'id',request_record_id,'title','Synthetic leave approval','requestType','Leave Request','status','Pending Approval',
    'requestedBy',owner_id::text,'requestedByName','Synthetic worker','employeeId',employee_id,
    'date',current_date::text,'endDate',current_date::text,'days',1,'leaveType','Annual'
  ),org_id,now(),now());
  update public.organization_members set role_id=hr_role_id where id=worker_membership_id;
  perform set_config('request.jwt.claim.sub',worker_id::text,true);
  result:=public.transition_approval_v2(org_id,'approvalRequests',request_record_id,'Pending Approval','APPROVE','Approved for QA');
  if result->>'status'<>'Approved' then raise exception 'HR request approval failed'; end if;
  if not exists(select 1 from public.records where organization_id=org_id and coll='leaves' and data->>'requestId'=request_record_id and data->>'status'='Approved') then raise exception 'approved leave side effect missing'; end if;

  insert into public.records(id,coll,data,organization_id,created_at,updated_at)
  values(lateness_request_id,'approvalRequests',jsonb_build_object(
    'id',lateness_request_id,'title','Synthetic lateness approval','requestType','Lateness Report','status','Pending Approval',
    'requestedBy',owner_id::text,'requestedByName','Synthetic worker','employeeId',employee_id,
    'date','2099-12-31','fromTime','10:15','reason','QA canary'
  ),org_id,now(),now());
  result:=public.transition_approval_v2(org_id,'approvalRequests',lateness_request_id,'Pending Approval','APPROVE','Approved for QA');
  if result->>'status'<>'Approved' then raise exception 'HR lateness approval failed'; end if;
  if not exists(select 1 from public.records where organization_id=org_id and coll='attendance' and data->>'employeeId'=employee_id and data->>'date'='2099-12-31' and data->>'status'='Late') then
    raise exception 'lateness attendance projection missing';
  end if;
  if not exists(select 1 from public.user_notifications_v2 where organization_id=org_id and recipient_user_id=owner_id and entity_id=request_record_id and notification_type='APPROVAL_APPROVE') then raise exception 'approval notification missing'; end if;
  if (select count(*) from public.approval_events_v2 event where event.organization_id=org_id and event.record_id in (deliverable_id,revision_deliverable_id,invoice_id,request_record_id,lateness_request_id))<>5 then raise exception 'approval events missing'; end if;
  if (select count(*) from public.audit_events audit where audit.organization_id=org_id and audit.entity_id in (deliverable_id,revision_deliverable_id,invoice_id,request_record_id,lateness_request_id) and audit.action like 'approval.%')<>5 then raise exception 'approval audit events missing'; end if;
end $test$;
rollback;`;

try {
  cli(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  process.stdout.write('Approvals V2 Staging E2E: 18 passed, 0 failed. Transaction rolled back.\n');
} catch (error) {
  console.error('Approvals V2 Staging E2E failed: ' + safe(error.message || error));
  process.exit(1);
}
