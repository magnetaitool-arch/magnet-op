#!/usr/bin/env node
'use strict';

// Live M10 canary. Refuses Production and rolls back every synthetic write.
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {PROTECTED_PROJECT_REFS}=require('./project-safety');
const EXPECTED_STAGING_NAME='MAGNET OS STAGING';
function argsOf(argv){const out={};for(const item of argv.slice(2)){if(!item.startsWith('--'))continue;const at=item.indexOf('=');out[item.slice(2,at<0?undefined:at)]=at<0?true:item.slice(at+1);}return out;}
function safe(value){return String(value||'').replace(/sbp_[A-Za-z0-9_-]+/g,'[REDACTED_TOKEN]').replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g,'[REDACTED_KEY]').replace(/eyJ[A-Za-z0-9_.-]+/g,'[REDACTED_JWT]').slice(-6000);}
function cli(args){const result=spawnSync('pnpm',['dlx','supabase@latest',...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,SUPABASE_TELEMETRY_DISABLED:'1'}});if(result.status!==0)throw new Error(safe(result.stderr||result.stdout));return result.stdout;}
function jsonCli(args){const output=cli(args);const a=output.indexOf('['),o=output.indexOf('{');const start=a>=0&&(o<0||a<o)?a:o;if(start<0)throw new Error('No JSON payload.');return JSON.parse(output.slice(start));}
const projectRef=String(argsOf(process.argv)['project-ref']||'').trim();
if(!/^[a-z]{20}$/.test(projectRef)||PROTECTED_PROJECT_REFS.has(projectRef)){console.error('Refused: explicit non-Production project ref required.');process.exit(2);}
const project=jsonCli(['projects','list','--output','json']).find(item=>item.ref===projectRef);
if(!project||project.name!==EXPECTED_STAGING_NAME||project.status!=='ACTIVE_HEALTHY'){console.error('Refused: target is not healthy MAGNET OS STAGING.');process.exit(2);}
const suffix=crypto.randomBytes(8).toString('hex');
const sql=`
begin;
do $test$
declare
  org_id uuid; owner_id uuid; worker_id uuid; outsider_id uuid; client_id uuid;
  project_id text; employee_id text; created jsonb; profile jsonb; listed jsonb; searched jsonb;
  created_task_id uuid; task_version integer; denied boolean:=false; stale boolean:=false; append_denied boolean:=false;
begin
  select id into org_id from public.organizations where slug='magnet' and status='ACTIVE' and deleted_at is null;
  select membership.user_id into owner_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id join public.profiles profile on profile.id=membership.user_id where membership.organization_id=org_id and membership.status='ACTIVE' and profile.identity_status='ACTIVE' and role.key in ('owner','admin') limit 1;
  select membership.user_id,coalesce(profile.employee_id,link.employee_record_id) into worker_id,employee_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id join public.profiles profile on profile.id=membership.user_id left join public.legacy_identity_links link on link.auth_user_id=membership.user_id and link.link_status='CONFIRMED' where membership.organization_id=org_id and membership.status='ACTIVE' and profile.identity_status='ACTIVE' and role.key in ('content_creator','designer','sales') and coalesce(profile.employee_id,link.employee_record_id) is not null limit 1;
  select membership.user_id into outsider_id from public.organization_members membership join public.organization_roles role on role.id=membership.role_id join public.profiles profile on profile.id=membership.user_id where membership.organization_id=org_id and membership.status='ACTIVE' and profile.identity_status='ACTIVE' and role.key in ('finance','hr') and membership.user_id<>worker_id limit 1;
  select client.id,record.id into client_id,project_id
  from public.records record join public.client_accounts client
    on client.organization_id=record.organization_id and client.legacy_record_id=record.data->>'clientId' and client.deleted_at is null
  where record.organization_id=org_id and record.coll='projects' and record.deleted_at is null limit 1;
  if org_id is null or owner_id is null or worker_id is null or outsider_id is null or client_id is null or project_id is null then raise exception 'missing staging canary data';end if;
  if has_function_privilege('anon','public.list_tasks_v2(uuid,text,text,text,uuid,text,integer,integer)','EXECUTE') then raise exception 'anonymous task RPC leak';end if;
  if has_table_privilege('authenticated','public.work_tasks','INSERT') then raise exception 'direct task insert leak';end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  created:=public.create_task_v2(org_id,'Synthetic M10 ${suffix}',client_id,project_id,employee_id,'Backlog','High','QA',current_date,current_date+2,2,'rollback-only','Verify completion',null,false);
  if coalesce((created->>'ok')::boolean,false) is not true then raise exception 'task creation failed';end if;
  created_task_id:=(created->'task'->>'id')::uuid; task_version:=(created->'task'->>'version')::integer;
  if (select count(*) from public.task_events_v2 event where event.task_id=created_task_id and event.action='CREATED')<>1 then raise exception 'created event missing';end if;
  if (select count(*) from public.user_notifications_v2 notification where notification.organization_id=org_id and notification.recipient_user_id=worker_id and notification.entity_id=created_task_id::text and notification.notification_type='TASK_ASSIGNED')<>1 then raise exception 'assignee notification missing';end if;
  listed:=public.list_tasks_v2(org_id,'ALL',null,'Synthetic M10',null,null,1,10);
  if (listed->>'total')::integer<>1 then raise exception 'owner list/search failed';end if;
  searched:=public.global_search_v2(org_id,'Synthetic M10',20);
  if jsonb_array_length(searched->'items')<1 then raise exception 'global search missed task';end if;
  perform set_config('request.jwt.claim.sub',outsider_id::text,true);
  if public.can_read_task_v2(org_id,null,worker_id,employee_id,false) then raise exception 'unassigned limited user can read task';end if;
  begin perform public.change_task_status_v2(org_id,created_task_id,task_version,'Done',null);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'unassigned user changed task status';end if;
  perform set_config('request.jwt.claim.sub',worker_id::text,true);
  profile:=public.change_task_status_v2(org_id,created_task_id,task_version,'In Progress',null); task_version:=(profile->'task'->>'version')::integer;
  profile:=public.change_task_status_v2(org_id,created_task_id,task_version,'Done',null); task_version:=(profile->'task'->>'version')::integer;
  if profile->'task'->>'status'<>'Done' or profile->'task'->>'completedAt' is null then raise exception 'assignee Done failed';end if;
  perform public.add_task_comment_v2(org_id,created_task_id,'Synthetic comment','INTERNAL');
  profile:=public.get_task_v2(org_id,created_task_id);
  if jsonb_array_length(profile->'comments')<>1 then raise exception 'comment missing';end if;
  begin perform public.change_task_status_v2(org_id,created_task_id,task_version-1,'In Progress',null);exception when serialization_failure then stale:=true;end;
  if not stale then raise exception 'stale task write accepted';end if;
  begin update public.task_events_v2 set note='tampered' where task_events_v2.task_id=created_task_id;exception when insufficient_privilege then append_denied:=true;end;
  if not append_denied then raise exception 'task timeline was mutable';end if;
  if (public.list_notifications_v2(org_id,false,100)->>'unread')::integer<1 then raise exception 'worker inbox is empty';end if;
  perform public.mark_notifications_read_v2(org_id,null);
  if (public.list_notifications_v2(org_id,true,100)->>'unread')::integer<>0 then raise exception 'mark-all read failed';end if;
end $test$;
rollback;`;
try{cli(['db','query','--linked','--project-ref',projectRef,'--output','json',sql]);process.stdout.write('Tasks/Search/Notifications V2 Staging E2E: 24 passed, 0 failed. Transaction rolled back.\n');}
catch(error){console.error('Tasks/Search/Notifications V2 Staging E2E failed: '+safe(error.message||error));process.exit(1);}
