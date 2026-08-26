#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('supabase/migrations/20260826023000_tasks_search_notifications_v2.sql');
const searchRepair=read('supabase/migrations/20260826024500_repair_global_search_v2.sql');
const app=read('index.html');
let passed=0,failed=0;
function check(value,label){if(value){passed++;console.log('  ok   '+label);}else{failed++;console.log('  FAIL '+label);}}

console.log('[1] canonical task model and projection');
check(/create table if not exists public\.work_tasks/.test(migration),'creates canonical tasks');
check(/organization_id uuid not null references public\.organizations/.test(migration),'tasks are tenant scoped');
check(/unique\(organization_id,legacy_record_id\)/.test(migration),'legacy projection is idempotent');
check(/project_task_record_v2/.test(migration),'legacy task changes project forward');
check(/M10 task projection mismatch/.test(migration),'backfill validates source and projection counts');
check(/task_projection_issues_v2/.test(migration),'data-quality issues are inventoried');
check(/ASSIGNEE_NOT_LINKED_TO_LOGIN/.test(migration),'unlinked assignees are explicit');
check(!/delete from public\.records/i.test(migration),'migration never deletes legacy tasks');

console.log('\n[2] accountable task commands and authorization');
check(/create or replace function public\.change_task_status_v2/.test(migration),'status command exists');
check(/task_is_current_assignee_v2/.test(migration),'assignee identity is resolved server-side');
check(/assignee_transition_not_allowed/.test(migration),'employee transitions are narrowly scoped');
check(/task_version_conflict/.test(migration),'task mutations use optimistic concurrency');
check(/invalid_task_transition/.test(migration),'workflow transitions fail closed');
check(/task_events_v2_append_only/.test(migration),'task timeline is append-only');
check(/create or replace function public\.add_task_comment_v2/.test(migration),'comments use an authorized command');
check(/create or replace function public\.link_task_document_v2/.test(migration),'documents link through an authorized command');
check(/current_member_role_key\(p_organization_id\)<>'client' or comment\.visibility='CLIENT'/.test(migration),'clients cannot read internal comments');
check(/revoke all privileges on public\.work_tasks.*from public,anon,authenticated/.test(migration),'direct task mutation is revoked');
check(/revoke all on function public\.list_tasks_v2[^\n]+from public,anon/.test(migration),'anonymous task RPC access is revoked');

console.log('\n[3] per-user notifications and permission-aware search');
check(/create table if not exists public\.user_notifications_v2/.test(migration),'creates per-user notifications');
check(/unique\(organization_id,recipient_user_id,source_key\)/.test(migration),'notification delivery is idempotent');
check(/recipient_user_id=auth\.uid\(\)/.test(migration),'notification reads bind to the JWT subject');
check(/create or replace function public\.mark_notifications_read_v2/.test(migration),'read receipts use a self-scoped command');
check(/create or replace function public\.global_search_v2/.test(migration),'global search RPC exists');
check(/public\.can_read_task_v2/.test(migration) && /public\.can_read_document_v2/.test(migration),'search reuses server authorization boundaries');
check(/public\.has_org_capability\(p_organization_id,'finance\.read'\)/.test(migration),'finance search is capability gated');
check(/public\.has_org_capability\(p_organization_id,'hr\.read'\)/.test(migration),'recruitment search is capability gated');
check(/client\.display_name/.test(searchRepair) && /lead\.display_name/.test(searchRepair),'search uses canonical CRM and client names');
check(/invoice\.stored_status/.test(searchRepair) && /contract\.contract_type/.test(searchRepair),'search uses canonical finance and contract fields');

console.log('\n[4] Tasks V2 product experience');
check(/function TasksWorkspaceV2\(/.test(app),'dedicated Tasks V2 workspace exists');
check(/function TaskProfileV2\(/.test(app),'task profile is separate from edit');
check(/function TaskEditorV2\(/.test(app),'task editor is explicit');
check(/case 'tasks': return html`<\$\{TasksWorkspaceV2\}/.test(app),'Tasks navigation uses V2');
check(/list_tasks_v2/.test(app) && /get_task_v2/.test(app),'task list and profile load through authorized RPCs');
check(/change_task_status_v2/.test(app),'employee Done uses the server status command');
check(/add_task_comment_v2/.test(app),'task comments use the server command');
check(/link_task_document_v2/.test(app),'task documents can be linked');
check(/ASSIGNEE|غير مربوط بحساب|Login not linked/.test(app),'unlinked assignee risk is visible');
check(/magnet:new-task/.test(app),'global quick-create opens Tasks V2');
check(/open'\)==='tasks'/.test(app),'task deep links are handled');
check(/@media\(max-width:900px\)[^\n]*task-toolbar/.test(app),'Tasks V2 has a mobile layout');

console.log('\n[5] actionable notifications and global search UX');
check(/function CommandPalette\(\{ items, onClose, searchProvider \}\)/.test(app),'command palette accepts server search');
check(/global_search_v2/.test(app),'command palette calls permission-aware search');
check(/list_notifications_v2/.test(app),'app loads the current user notification inbox');
check(/mark_notifications_read_v2/.test(app),'read receipts are persisted server-side');
check(/setInterval\(\(\)=>\{if\(live\)refreshCanonicalNotifications\(\);\},30000\)/.test(app),'notification inbox refreshes without full database polling');
check(/openEntity\(n\.route\|\|n\.entityType,n\.entityId\)/.test(app),'notification click opens the exact entity');
check(/CustomEvent\('magnet:open-entity'/.test(app),'same-route search results dispatch an exact-entity event');
check((app.match(/addEventListener\('magnet:open-entity'/g)||[]).length>=5,'V2 workspaces handle same-route exact-entity events');
check(/organizationId:authUser\.organizationId/.test(app) && /capabilities:Array\.isArray\(authUser\.capabilities\)/.test(app),'canonical organization and capabilities reach V2 workspaces');
check(/Array\.isArray\(canonicalNotifs\)\?canonicalNotifs:legacyNotifs/.test(app),'legacy inbox remains an explicit fallback');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed?1:0);
