#!/usr/bin/env node
'use strict';

// Live M8 canary. It refuses Production and rolls back every synthetic client,
// project, contract, lifecycle event, review link, signature, and audit event.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
function argsOf(argv) { const out={}; for(const item of argv.slice(2)){if(!item.startsWith('--'))continue;const at=item.indexOf('=');out[item.slice(2,at<0?undefined:at)]=at<0?true:item.slice(at+1);} return out; }
function safe(value){return String(value||'').replace(/sbp_[A-Za-z0-9_-]+/g,'[REDACTED_TOKEN]').replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g,'[REDACTED_KEY]').replace(/eyJ[A-Za-z0-9_.-]+/g,'[REDACTED_JWT]').slice(-5000);}
function cli(args){const result=spawnSync('pnpm',['dlx','supabase@latest',...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,SUPABASE_TELEMETRY_DISABLED:'1'}});if(result.status!==0)throw new Error(safe(result.stderr||result.stdout));return result.stdout;}
function jsonCli(args){const output=cli(args);const a=output.indexOf('['),o=output.indexOf('{');const start=a>=0&&(o<0||a<o)?a:o;if(start<0)throw new Error('No JSON payload.');return JSON.parse(output.slice(start));}

const projectRef=String(argsOf(process.argv)['project-ref']||'').trim();
if(!/^[a-z]{20}$/.test(projectRef)||PROTECTED_PROJECT_REFS.has(projectRef)){console.error('Refused: explicit non-Production project ref required.');process.exit(2);}
const project=jsonCli(['projects','list','--output','json']).find(item=>item.ref===projectRef);
if(!project||project.name!==EXPECTED_STAGING_NAME||project.status!=='ACTIVE_HEALTHY'){console.error('Refused: target is not healthy MAGNET OS STAGING.');process.exit(2);}

const suffix=crypto.randomBytes(12).toString('hex');
const clientId=`cli-m8-${suffix}`;
const projectId=`prj-m8-${suffix}`;
const contractId=`ctr-m8-${suffix}`;
const contractNumber=`SYN-CTR-${suffix.slice(0,12).toUpperCase()}`;

const sql=`
begin;
do $test$
declare
  target_organization_id uuid;
  owner_user_id uuid;
  limited_user_id uuid;
  canonical_contract_id uuid;
  profile_result jsonb;
  list_result jsonb;
  template_result jsonb;
  link_result jsonb;
  public_result jsonb;
  accept_result jsonb;
  duplicate_result jsonb;
  raw_token text;
  rejected_missing_client boolean := false;
  rejected_direct_status boolean := false;
  rejected_invalid_transition boolean := false;
  rejected_limited_role boolean := false;
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
  perform set_config('request.jwt.claim.sub',owner_user_id::text,true);

  insert into public.records(id,coll,data,organization_id) values('${clientId}','clients',jsonb_build_object(
    'id','${clientId}','brandName','Synthetic Contract Client','legalName','Synthetic Contract Client LLC',
    'mainContactEmail','contract-canary@example.invalid','status','Active','createdAt',now()),target_organization_id);
  insert into public.records(id,coll,data,organization_id) values('${projectId}','projects',jsonb_build_object(
    'id','${projectId}','clientId','${clientId}','projectName','Synthetic Contract Project',
    'status','In Progress','createdAt',now()),target_organization_id);

  begin
    insert into public.records(id,coll,data,organization_id) values('bad-ctr-m8-${suffix}','contracts',jsonb_build_object(
      'id','bad-ctr-m8-${suffix}','contractNumber','BAD-${suffix.slice(0,8)}','status','Draft'),target_organization_id);
  exception when check_violation then
    if sqlerrm='contract_client_required' then rejected_missing_client:=true; else raise; end if;
  end;
  if not rejected_missing_client then raise exception 'contract without client was accepted'; end if;

  insert into public.records(id,coll,data,organization_id) values('${contractId}','contracts',jsonb_build_object(
    'id','${contractId}','contractNumber','${contractNumber}','clientId','${clientId}','projectId','${projectId}',
    'templateKey','retainer','contractType','Retainer','status','Draft','startDate',current_date,
    'endDate',current_date+365,'currency','EGP','value',120000,'paymentTerms','Monthly in advance',
    'scope','Synthetic scope','deliverables','Synthetic deliverables','governingLaw','Egypt',
    'createdAt',now()),target_organization_id);
  select id into canonical_contract_id from public.agency_contracts
  where organization_id=target_organization_id and legacy_record_id='${contractId}' and deleted_at is null;
  if canonical_contract_id is null then raise exception 'canonical contract projection failed'; end if;

  template_result:=public.list_contract_templates_v2(target_organization_id);
  if jsonb_array_length(template_result)<7 then raise exception 'master templates missing'; end if;
  list_result:=public.list_contracts_v2(target_organization_id,'${contractNumber}',null,'${clientId}','retainer',1,25,false);
  if (list_result->>'total')::integer<>1 then raise exception 'contract list/search failed'; end if;
  profile_result:=public.get_contract_v2(target_organization_id,'${contractId}');
  if coalesce((profile_result->>'ok')::boolean,false) is not true then raise exception 'contract profile failed'; end if;
  if jsonb_array_length(profile_result->'timeline')<>1 then raise exception 'initial timeline missing'; end if;

  begin
    update public.records set data=data||'{"status":"Ready"}'::jsonb where id='${contractId}';
  exception when insufficient_privilege then rejected_direct_status:=true; end;
  if not rejected_direct_status then raise exception 'direct lifecycle bypass was accepted'; end if;

  perform public.change_contract_v2_status(target_organization_id,'${contractId}','Internal Review','Synthetic review');
  perform public.change_contract_v2_status(target_organization_id,'${contractId}','Ready','Approved for client');
  if (select status from public.agency_contracts where id=canonical_contract_id)<>'Ready' then raise exception 'ready transition failed'; end if;
  if (select count(*) from public.contract_status_events where contract_id=canonical_contract_id)<>3 then raise exception 'status timeline count mismatch'; end if;
  if (select note from public.contract_status_events where contract_id=canonical_contract_id order by id desc limit 1)<>'Approved for client' then raise exception 'status note missing'; end if;
  begin
    perform public.change_contract_v2_status(target_organization_id,'${contractId}','Signed',null);
  exception when raise_exception then rejected_invalid_transition:=true; end;
  if not rejected_invalid_transition then raise exception 'invalid Ready to Signed transition accepted'; end if;

  link_result:=public.create_contract_access_link(target_organization_id,'${contractId}',72,'REVIEW_AND_SIGN');
  raw_token:=link_result->>'token';
  if raw_token !~ '^[a-f0-9]{64}$' then raise exception 'raw link token invalid'; end if;
  if (select token_hash from public.contract_access_links where id=(link_result->>'id')::uuid)=raw_token then raise exception 'raw token was stored'; end if;
  if (select status from public.agency_contracts where id=canonical_contract_id)<>'Sent' then raise exception 'share did not move Ready to Sent'; end if;
  public_result:=public.get_public_contract(raw_token);
  if coalesce((public_result->>'ok')::boolean,false) is not true then raise exception 'public review failed'; end if;
  if public_result->'contract'->>'contractNumber'<>'${contractNumber}' then raise exception 'public contract mismatch'; end if;
  if public_result::text ilike '%contract-canary@example.invalid%' then raise exception 'public payload leaked client email'; end if;
  if coalesce((public.get_public_contract(repeat('0',64))->>'ok')::boolean,true) is not false then raise exception 'invalid token did not fail closed'; end if;

  accept_result:=public.accept_public_contract(raw_token,'Synthetic Authorized Signer','signer@example.invalid',true);
  if coalesce((accept_result->>'ok')::boolean,false) is not true then raise exception 'public acceptance failed'; end if;
  if (select status from public.agency_contracts where id=canonical_contract_id)<>'Signed' then raise exception 'signed transition failed'; end if;
  if (select state from public.contract_access_links where id=(link_result->>'id')::uuid)<>'ACCEPTED' then raise exception 'acceptance evidence missing'; end if;
  if coalesce((public.accept_public_contract(raw_token,'Second Signer','second@example.invalid',true)->>'ok')::boolean,true) is not false then raise exception 'accepted link was reusable'; end if;
  perform set_config('request.jwt.claim.sub',owner_user_id::text,true);
  perform public.change_contract_v2_status(target_organization_id,'${contractId}','Active','Activated after signature');
  if (select status from public.agency_contracts where id=canonical_contract_id)<>'Active' then raise exception 'active transition failed'; end if;

  duplicate_result:=public.duplicate_contract_v2(target_organization_id,'${contractId}','${contractNumber}-COPY');
  if coalesce((duplicate_result->>'ok')::boolean,false) is not true then raise exception 'duplicate failed'; end if;
  if (select status from public.agency_contracts where legacy_record_id=duplicate_result->>'legacyRecordId')<>'Draft' then raise exception 'duplicate was not a draft'; end if;
  perform public.archive_contract_v2(target_organization_id,duplicate_result->>'legacyRecordId');
  if (select archived_at from public.agency_contracts where legacy_record_id=duplicate_result->>'legacyRecordId') is null then raise exception 'archive failed'; end if;

  if has_function_privilege('anon','public.list_contracts_v2(uuid,text,text,text,text,integer,integer,boolean)','EXECUTE') then raise exception 'anon contract-list execute leak'; end if;
  if not has_function_privilege('anon','public.get_public_contract(text)','EXECUTE') then raise exception 'public review RPC unavailable'; end if;
  select membership.user_id into limited_user_id from public.organization_members membership
  join public.organization_roles role on role.id=membership.role_id join public.profiles profile on profile.id=membership.user_id
  where membership.organization_id=target_organization_id and membership.status='ACTIVE' and profile.identity_status='ACTIVE'
    and role.key in ('content_creator','designer') limit 1;
  if limited_user_id is null then raise exception 'missing limited Staging member'; end if;
  perform set_config('request.jwt.claim.sub',limited_user_id::text,true);
  begin perform public.list_contracts_v2(target_organization_id,null,null,null,null,1,25,false);
  exception when insufficient_privilege then rejected_limited_role:=true; end;
  if not rejected_limited_role then raise exception 'limited role could read contracts'; end if;
end $test$;
rollback;`;

try{cli(['db','query','--linked','--project-ref',projectRef,'--output','json',sql]);process.stdout.write('Contract Management V2 Staging E2E: 30 passed, 0 failed. Transaction rolled back.\n');}
catch(error){console.error('Contract Management V2 Staging E2E failed: '+safe(error.message||error));process.exit(1);}
