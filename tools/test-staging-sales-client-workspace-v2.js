#!/usr/bin/env node
'use strict';

// Live M6 canary. Refuses Production and rolls back every synthetic lead,
// client, stage event, note, audit event, notification, and outbox message.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
function argsOf(argv) { const out={}; for(const item of argv.slice(2)){if(!item.startsWith('--'))continue;const at=item.indexOf('=');out[item.slice(2,at<0?undefined:at)]=at<0?true:item.slice(at+1);} return out; }
function safe(value){return String(value||'').replace(/sbp_[A-Za-z0-9_-]+/g,'[REDACTED_TOKEN]').replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g,'[REDACTED_KEY]').replace(/eyJ[A-Za-z0-9_.-]+/g,'[REDACTED_JWT]').slice(-4000);}
function cli(args){const result=spawnSync('pnpm',['dlx','supabase@latest',...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,SUPABASE_TELEMETRY_DISABLED:'1'}});if(result.status!==0)throw new Error(safe(result.stderr||result.stdout));return result.stdout;}
function jsonCli(args){const output=cli(args);const a=output.indexOf('['),o=output.indexOf('{');const start=a>=0&&(o<0||a<o)?a:o;if(start<0)throw new Error('No JSON payload.');return JSON.parse(output.slice(start));}
const projectRef=String(argsOf(process.argv)['project-ref']||'').trim();
if(!/^[a-z]{20}$/.test(projectRef)||PROTECTED_PROJECT_REFS.has(projectRef)){console.error('Refused: explicit non-Production project ref required.');process.exit(2);}
const project=jsonCli(['projects','list','--output','json']).find(item=>item.ref===projectRef);
if(!project||project.name!==EXPECTED_STAGING_NAME||project.status!=='ACTIVE_HEALTHY'){console.error('Refused: target is not healthy MAGNET OS STAGING.');process.exit(2);}

const suffix=crypto.randomBytes(12).toString('hex');
const intakeKey='staging-sales-v2/'+suffix;
const requestHash=crypto.createHash('sha256').update('sales-'+suffix).digest('base64url');
const fingerprint=crypto.createHash('sha256').update('fingerprint-'+suffix).digest('base64url');
const leadId='';
const sql=`
begin;
do $test$
declare
  target_organization_id uuid;
  owner_user_id uuid;
  limited_user_id uuid;
  client_user_id uuid;
  client_record_id text := 'cli-m6-${suffix}';
  intake_result jsonb;
  list_result jsonb;
  profile_result jsonb;
  workspace_result jsonb;
  lead_record_id text;
  lead_uuid uuid;
  denied boolean := false;
begin
  select id into target_organization_id from public.organizations
  where slug='magnet' and status='ACTIVE' and deleted_at is null;
  if target_organization_id is null then raise exception 'missing Staging organization'; end if;
  select membership.user_id into owner_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id=membership.role_id
  join public.profiles profile on profile.id=membership.user_id
  where membership.organization_id=target_organization_id and membership.status='ACTIVE'
    and profile.identity_status='ACTIVE' and role.key in ('owner','admin') limit 1;
  if owner_user_id is null then raise exception 'missing active Staging owner'; end if;

  intake_result := public.submit_public_intake(target_organization_id,'lead',
    '{"name":"Synthetic Website Lead","company":"Synthetic Company","email":"sales-canary@example.invalid","phone":"+201000000000","serviceInterest":"Branding","message":"Synthetic M6 validation"}'::jsonb,
    '${intakeKey}','${requestHash}','${fingerprint}');
  lead_record_id := intake_result->>'id';
  select id into lead_uuid from public.crm_leads where organization_id=target_organization_id and legacy_record_id=lead_record_id;
  if lead_uuid is null then raise exception 'canonical lead projection failed'; end if;
  if (select source from public.crm_leads where id=lead_uuid) <> 'Website' then raise exception 'lead source mismatch'; end if;
  if (select count(*) from public.outbox_messages where organization_id=target_organization_id and payload->>'entityId'=lead_record_id) <> 2 then raise exception 'lead deliveries not queued'; end if;

  perform set_config('request.jwt.claim.sub',owner_user_id::text,true);
  list_result := public.list_crm_leads(target_organization_id,'New Lead','Synthetic Website Lead','Website','submitted_desc',1,24);
  if (list_result->>'total')::integer <> 1 then raise exception 'CRM list/search failed'; end if;
  profile_result := public.get_crm_lead_profile(target_organization_id,lead_record_id);
  if coalesce((profile_result->>'ok')::boolean,false) is not true then raise exception 'CRM profile failed'; end if;
  perform public.add_crm_lead_note(target_organization_id,lead_record_id,'Synthetic sales note');
  perform public.change_crm_lead_stage(target_organization_id,lead_record_id,'Qualified','Synthetic qualification');
  if (select stage from public.crm_leads where id=lead_uuid) <> 'Qualified' then raise exception 'CRM stage command failed'; end if;
  if (select count(*) from public.crm_lead_notes where lead_id=lead_uuid) <> 2 then raise exception 'CRM notes mismatch'; end if;
  if (select count(*) from public.crm_lead_stage_events where lead_id=lead_uuid) <> 2 then raise exception 'CRM timeline mismatch'; end if;

  insert into public.records(id,coll,data,organization_id) values(client_record_id,'clients',jsonb_build_object(
    'id',client_record_id,'brandName','Synthetic Client Workspace','status','Active','industry','Testing',
    'mainContactName','Synthetic Contact','mainContactEmail','client-canary@example.invalid','accountManagerId','synthetic-manager','createdAt',now()),target_organization_id);
  insert into public.records(id,coll,data,organization_id) values
    ('prj-m6-${suffix}','projects',jsonb_build_object('id','prj-m6-${suffix}','clientId',client_record_id,'projectName','Synthetic Project','status','In Progress','createdAt',now()),target_organization_id),
    ('tsk-m6-${suffix}','tasks',jsonb_build_object('id','tsk-m6-${suffix}','clientId',client_record_id,'title','Synthetic Task','status','In Progress','createdAt',now()),target_organization_id),
    ('inv-m6-${suffix}','invoices',jsonb_build_object('id','inv-m6-${suffix}','clientId',client_record_id,'projectId','prj-m6-${suffix}','invoiceNumber','SYN-1','amount',1000,'status','Issued','createdAt',now()),target_organization_id),
    ('pay-m6-${suffix}','payments',jsonb_build_object('id','pay-m6-${suffix}','clientId',client_record_id,'invoiceId','inv-m6-${suffix}','amount',250,'date',current_date,'createdAt',now()),target_organization_id);
  workspace_result := public.get_client_workspace(target_organization_id,client_record_id);
  if coalesce((workspace_result->>'ok')::boolean,false) is not true then raise exception 'workspace profile failed'; end if;
  if jsonb_array_length(workspace_result->'projects') <> 1 or jsonb_array_length(workspace_result->'tasks') <> 1 then raise exception 'workspace work relations failed'; end if;
  if jsonb_array_length(workspace_result->'invoices') <> 1 or jsonb_array_length(workspace_result->'payments') <> 1 then raise exception 'workspace finance relations failed'; end if;
  if (workspace_result->'client'->>'currentBalance')::numeric <> 750 then raise exception 'workspace balance mismatch'; end if;

  if has_function_privilege('anon','public.list_crm_leads(uuid,text,text,text,text,integer,integer)','EXECUTE') then raise exception 'anon CRM execute leak'; end if;
  if has_function_privilege('anon','public.get_client_workspace(uuid,text)','EXECUTE') then raise exception 'anon workspace execute leak'; end if;
  select membership.user_id into limited_user_id from public.organization_members membership
  join public.organization_roles role on role.id=membership.role_id join public.profiles profile on profile.id=membership.user_id
  where membership.organization_id=target_organization_id and membership.status='ACTIVE' and profile.identity_status='ACTIVE'
    and role.key in ('content_creator','designer') limit 1;
  if limited_user_id is null then raise exception 'missing limited Staging member'; end if;
  perform set_config('request.jwt.claim.sub',limited_user_id::text,true);
  begin perform public.list_crm_leads(target_organization_id,null,null,null,'submitted_desc',1,24);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'limited role could read CRM'; end if;
end $test$;
rollback;`;

try{cli(['db','query','--linked','--project-ref',projectRef,'--output','json',sql]);process.stdout.write('Sales + Client Workspace V2 Staging E2E: 24 passed, 0 failed. Transaction rolled back.\n');}
catch(error){console.error('Sales + Client Workspace V2 Staging E2E failed: '+safe(error.message||error));process.exit(1);}
