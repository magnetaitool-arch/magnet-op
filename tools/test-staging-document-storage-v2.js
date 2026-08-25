#!/usr/bin/env node
'use strict';

// Live M9 canary. It refuses Production and performs every synthetic metadata,
// Storage-object, permission, lifecycle, and audit check inside one rollback.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
function argsOf(argv) { const out={}; for(const item of argv.slice(2)){if(!item.startsWith('--'))continue;const at=item.indexOf('=');out[item.slice(2,at<0?undefined:at)]=at<0?true:item.slice(at+1);} return out; }
function safe(value){return String(value||'').replace(/sbp_[A-Za-z0-9_-]+/g,'[REDACTED_TOKEN]').replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g,'[REDACTED_KEY]').replace(/eyJ[A-Za-z0-9_.-]+/g,'[REDACTED_JWT]').slice(-6000);}
function cli(args){const result=spawnSync('pnpm',['dlx','supabase@latest',...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,SUPABASE_TELEMETRY_DISABLED:'1'}});if(result.status!==0)throw new Error(safe(result.stderr||result.stdout));return result.stdout;}
function jsonCli(args){const output=cli(args);const a=output.indexOf('['),o=output.indexOf('{');const start=a>=0&&(o<0||a<o)?a:o;if(start<0)throw new Error('No JSON payload.');return JSON.parse(output.slice(start));}

const projectRef=String(argsOf(process.argv)['project-ref']||'').trim();
if(!/^[a-z]{20}$/.test(projectRef)||projectRef===PRODUCTION_REF){console.error('Refused: explicit non-Production project ref required.');process.exit(2);}
const project=jsonCli(['projects','list','--output','json']).find(item=>item.ref===projectRef);
if(!project||project.name!==EXPECTED_STAGING_NAME||project.status!=='ACTIVE_HEALTHY'){console.error('Refused: target is not healthy MAGNET OS STAGING.');process.exit(2);}

const suffix=crypto.randomBytes(12).toString('hex');
const sql=`
begin;
do $test$
declare
  target_organization_id uuid;
  owner_user_id uuid;
  limited_user_id uuid;
  finance_user_id uuid;
  target_client_id uuid;
  image_slot jsonb;
  failed_slot jsonb;
  limited_slot jsonb;
  profile_result jsonb;
  list_result jsonb;
  update_result jsonb;
  state_result jsonb;
  test_document_id uuid;
  current_version integer;
  missing_objects_rejected boolean := false;
  invalid_client_rejected boolean := false;
  sensitive_upload_rejected boolean := false;
  stale_write_rejected boolean := false;
  append_mutation_rejected boolean := false;
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
  select membership.user_id into limited_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id=membership.role_id
  join public.profiles profile on profile.id=membership.user_id
  where membership.organization_id=target_organization_id and membership.status='ACTIVE'
    and profile.identity_status='ACTIVE' and role.key in ('content_creator','designer') limit 1;
  select membership.user_id into finance_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id=membership.role_id
  join public.profiles profile on profile.id=membership.user_id
  where membership.organization_id=target_organization_id and membership.status='ACTIVE'
    and profile.identity_status='ACTIVE' and role.key='finance' limit 1;
  select id into target_client_id from public.client_accounts
  where organization_id=target_organization_id and deleted_at is null limit 1;
  if owner_user_id is null or limited_user_id is null or finance_user_id is null or target_client_id is null then
    raise exception 'missing Staging canary identities or client'; end if;

  if (select public from storage.buckets where id='magnet-documents') is distinct from false then raise exception 'document bucket is not private'; end if;
  if (select file_size_limit from storage.buckets where id='magnet-documents')<>26214400 then raise exception 'bucket size limit mismatch'; end if;
  if has_table_privilege('anon','public.document_files','SELECT') then raise exception 'anonymous metadata read leak'; end if;
  if has_table_privilege('authenticated','public.document_files','INSERT') then raise exception 'browser direct metadata insert leak'; end if;
  if has_function_privilege('anon','public.list_documents_v2(uuid,text,text,text,uuid,text,text,integer,integer)','EXECUTE') then raise exception 'anonymous document-list execute leak'; end if;
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and cmd='DELETE' and policyname like 'magnet_documents%') then raise exception 'browser physical delete policy exists'; end if;

  perform set_config('request.jwt.claim.sub',owner_user_id::text,true);
  image_slot:=public.create_document_upload_v2(target_organization_id,'Synthetic M9 Image','Client File','CLIENT',
    'unsafe original name.JPG','image/jpeg',2048,true,'SYN-M9-${suffix.slice(0,10).toUpperCase()}',current_date,
    array['canary','image'],'rollback-only',target_client_id,null,null,null,null);
  if coalesce((image_slot->>'ok')::boolean,false) is not true then raise exception 'image upload slot failed'; end if;
  test_document_id:=(image_slot->>'id')::uuid;
  if image_slot->>'originalPath' !~ ('^'||target_organization_id::text||'/[a-f0-9-]{36}/original\\.jpg$') then raise exception 'opaque original path mismatch'; end if;
  if image_slot->>'optimizedPath' !~ '/optimized\\.webp$' or image_slot->>'thumbnailPath' !~ '/thumbnail\\.webp$' then raise exception 'variant paths missing'; end if;
  if (image_slot->>'originalPath') ilike '%unsafe%' then raise exception 'raw filename leaked into object path'; end if;
  if (select count(*) from public.document_events event where event.document_id=test_document_id and event.action='UPLOAD_STARTED')<>1 then raise exception 'upload start event missing'; end if;

  begin
    perform public.finalize_document_upload_v2(target_organization_id,test_document_id,repeat('a',64),1024,256);
  exception when raise_exception then
    if sqlerrm='original_upload_missing' then missing_objects_rejected:=true; else raise; end if;
  end;
  if not missing_objects_rejected then raise exception 'finalize accepted missing objects'; end if;

  insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values
    ('magnet-documents',image_slot->>'originalPath',owner_user_id,owner_user_id::text,'{"mimetype":"image/jpeg","size":2048}'::jsonb),
    ('magnet-documents',image_slot->>'optimizedPath',owner_user_id,owner_user_id::text,'{"mimetype":"image/webp","size":1024}'::jsonb),
    ('magnet-documents',image_slot->>'thumbnailPath',owner_user_id,owner_user_id::text,'{"mimetype":"image/webp","size":256}'::jsonb);
  profile_result:=public.finalize_document_upload_v2(target_organization_id,test_document_id,repeat('b',64),1024,256);
  if coalesce((profile_result->>'ok')::boolean,false) is not true or profile_result->>'status'<>'ACTIVE' then raise exception 'finalize failed'; end if;
  if (select document.checksum_sha256 from public.document_files document where document.id=test_document_id)<>repeat('b',64) then raise exception 'checksum not persisted'; end if;
  if (select count(*) from public.document_events event where event.document_id=test_document_id)<>2 then raise exception 'completion event missing'; end if;
  if not public.document_storage_can_read(image_slot->>'originalPath') then raise exception 'owner cannot read authorized object'; end if;

  list_result:=public.list_documents_v2(target_organization_id,'Synthetic M9',null,null,target_client_id,null,'ACTIVE',1,25);
  if (list_result->>'total')::integer<>1 then raise exception 'document search/list failed'; end if;
  profile_result:=public.get_document_v2(target_organization_id,test_document_id);
  if coalesce((profile_result->>'ok')::boolean,false) is not true then raise exception 'document profile failed'; end if;
  current_version:=(profile_result->'document'->>'version')::integer;

  update_result:=public.update_document_metadata_v2(target_organization_id,test_document_id,current_version,
    'Synthetic M9 Finance Receipt','Payment Receipt','FINANCE_SENSITIVE','FIN-M9-${suffix.slice(0,8).toUpperCase()}',
    current_date,array['canary','finance'],'rollback-only',target_client_id,null);
  if coalesce((update_result->>'ok')::boolean,false) is not true then raise exception 'metadata update failed'; end if;
  current_version:=(update_result->>'version')::integer;
  begin
    perform public.update_document_metadata_v2(target_organization_id,test_document_id,current_version-1,
      'Stale write','Other','INTERNAL',null,null,'{}',null,null,null);
  exception when serialization_failure then stale_write_rejected:=true; end;
  if not stale_write_rejected then raise exception 'stale metadata write was accepted'; end if;

  perform set_config('request.jwt.claim.sub',limited_user_id::text,true);
  if public.can_read_document_v2(target_organization_id,'FINANCE_SENSITIVE',null,null) then raise exception 'limited role read finance document'; end if;
  if public.document_storage_can_read(image_slot->>'originalPath') then raise exception 'limited role read finance object'; end if;
  limited_slot:=public.create_document_upload_v2(target_organization_id,'Synthetic Limited Internal','Company Document','INTERNAL',
    'limited.pdf','application/pdf',512,false,null,current_date,'{}','rollback-only',null,null,null,null,null);
  if coalesce((limited_slot->>'ok')::boolean,false) is not true then raise exception 'authorized internal upload failed'; end if;
  perform public.cancel_document_upload_v2(target_organization_id,(limited_slot->>'id')::uuid);
  begin
    perform public.create_document_upload_v2(target_organization_id,'Forbidden HR File','Employee Document','HR_SENSITIVE',
      'private.pdf','application/pdf',512,false,null,current_date,'{}',null,null,null,null,null,null);
  exception when insufficient_privilege then sensitive_upload_rejected:=true; end;
  if not sensitive_upload_rejected then raise exception 'limited role created sensitive document'; end if;

  perform set_config('request.jwt.claim.sub',finance_user_id::text,true);
  if not public.can_read_document_v2(target_organization_id,'FINANCE_SENSITIVE',null,null) then raise exception 'finance role cannot read finance document'; end if;
  if not public.document_storage_can_read(image_slot->>'originalPath') then raise exception 'finance role cannot read finance object'; end if;

  perform set_config('request.jwt.claim.sub',owner_user_id::text,true);
  begin
    perform public.create_document_upload_v2(target_organization_id,'Invalid client share','Client File','CLIENT',
      'bad.pdf','application/pdf',512,false,null,current_date,'{}',null,null,null,null,null,null);
  exception when check_violation then
    if sqlerrm='client_document_requires_client' then invalid_client_rejected:=true; else raise; end if;
  end;
  if not invalid_client_rejected then raise exception 'client share without client was accepted'; end if;

  begin
    update public.document_events event set safe_context='{"tampered":true}'::jsonb where event.document_id=test_document_id;
  exception when insufficient_privilege then append_mutation_rejected:=true; end;
  if not append_mutation_rejected then raise exception 'append-only timeline was mutable'; end if;

  state_result:=public.change_document_state_v2(target_organization_id,test_document_id,current_version,'ARCHIVE');
  if state_result->>'status'<>'ARCHIVED' then raise exception 'archive failed'; end if;
  current_version:=(state_result->>'version')::integer;
  state_result:=public.change_document_state_v2(target_organization_id,test_document_id,current_version,'RESTORE');
  if state_result->>'status'<>'ACTIVE' then raise exception 'restore failed'; end if;
  current_version:=(state_result->>'version')::integer;
  state_result:=public.change_document_state_v2(target_organization_id,test_document_id,current_version,'DELETE');
  if state_result->>'status'<>'DELETED' then raise exception 'soft delete failed'; end if;
  if (select document.deleted_at from public.document_files document where document.id=test_document_id) is null then raise exception 'delete timestamp missing'; end if;
  if coalesce((public.get_document_v2(target_organization_id,test_document_id)->>'ok')::boolean,true) is not false then raise exception 'trashed document remained readable'; end if;

  failed_slot:=public.create_document_upload_v2(target_organization_id,'Synthetic Failed Upload','Other','INTERNAL',
    'failure.txt','text/plain',64,false,null,current_date,'{}','rollback-only',null,null,null,null,null);
  perform public.cancel_document_upload_v2(target_organization_id,(failed_slot->>'id')::uuid);
  if (select status from public.document_files where id=(failed_slot->>'id')::uuid)<>'FAILED' then raise exception 'failed upload state missing'; end if;

  if (select count(*) from public.document_import_issues issue where issue.organization_id=target_organization_id and issue.issue_code='LEGACY_EXTERNAL_LINK_REQUIRES_IMPORT')
     < (select count(*) from public.records record where record.organization_id=target_organization_id and record.coll='files' and record.deleted_at is null and lower(coalesce(record.data->>'_del','false'))<>'true') then
    raise exception 'legacy file inventory is incomplete'; end if;
end $test$;
rollback;`;

try {
  cli(['db','query','--linked','--project-ref',projectRef,'--output','json',sql]);
  process.stdout.write('Document Storage V2 Staging E2E: 38 passed, 0 failed. Transaction rolled back.\n');
} catch (error) {
  console.error('Document Storage V2 Staging E2E failed: '+safe(error.message||error));
  process.exit(1);
}
