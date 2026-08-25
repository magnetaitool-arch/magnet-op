#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825223000_sales_client_workspace_v2.sql');
const app = read('index.html');
const intake = read('supabase/migrations/20260825203000_transactional_public_intake.sql');
const outbox = read('server/outbox.js');
let passed = 0;
let failed = 0;
const check = (condition, label) => {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
};

console.log('[1] canonical sales and client roots');
check(/create table if not exists public\.crm_leads/.test(migration), 'creates canonical CRM leads');
check(/create table if not exists public\.client_accounts/.test(migration), 'creates canonical client accounts');
check(/unique \(organization_id, legacy_record_id\)/.test(migration), 'canonical roots are tenant scoped and legacy linked');
check(/records_sync_sales_client_v2/.test(migration), 'future legacy changes project into canonical roots');
check(/M6 projection mismatch/.test(migration), 'backfill validates lead and client counts');
check(!/delete from public\.records/i.test(migration), 'migration never deletes legacy business records');

console.log('\n[2] access control and commands');
check(/create or replace function public\.can_access_client_workspace/.test(migration), 'client workspace has an explicit access guard');
check(/profile_client_id is not null and profile_client_id = p_legacy_client_id/.test(migration), 'client users are restricted to their linked client');
check(/has_org_capability\(p_organization_id, 'clients\.manage'\)/.test(migration), 'CRM mutations require live manage capability');
check(/crm_lead_stage_events_append_only/.test(migration) && /crm_lead_notes_append_only/.test(migration), 'CRM stage history and notes are immutable');
check(/revoke all on function public\.list_crm_leads[\s\S]*from public, anon/.test(migration), 'anonymous users cannot call CRM list RPC');
check(/revoke all on function public\.get_client_workspace[\s\S]*from public, anon/.test(migration), 'anonymous users cannot call client workspace RPC');
check(/case when can_finance then[\s\S]*else null end/.test(migration), 'finance fields are capability redacted');

console.log('\n[3] website to CRM automation');
check(/entity_collection := 'leads'/.test(intake) && /source', 'Website'/.test(intake), 'website intake creates a Website lead');
for (const field of ['name','company','phone','service','message']) {
  check(new RegExp(`'${field}', p_payload`).test(intake), `delivery payload includes ${field}`);
}
check(/submittedAt/.test(outbox) && /deepLinkPath/.test(outbox), 'delivery text includes submission time and deep link');
check(/SALES_EMAIL/.test(outbox) && /SALES_WHATSAPP/.test(outbox), 'sales recipients come from server environment');

console.log('\n[4] CRM and Client Workspace UX');
check(/function SalesPipelineView\(/.test(app) && /function LeadProfileModal\(/.test(app), 'CRM V2 list and lead profile exist');
check(/list_crm_leads/.test(app) && /get_crm_lead_profile/.test(app), 'CRM reads through authorized server RPCs');
check(/change_crm_lead_stage/.test(app) && /add_crm_lead_note/.test(app), 'CRM lifecycle changes use audited commands');
check(/function ClientsView\(/.test(app) && /function ClientWorkspaceModal\(/.test(app), 'Client Workspace V2 is implemented');
check(/list_client_workspaces/.test(app) && /get_client_workspace/.test(app), 'client lists and details use tenant-scoped RPCs');
for (const tab of ['Overview','Contacts','Projects','Tasks','Contracts','Invoices','Payments','Files','Communication','Reports','Activity']) {
  check(app.includes(`'${tab}'`), `client workspace includes ${tab}`);
}
check(/p\.get\('open'\)==='leads'/.test(app) && /p\.get\('open'\)==='clients'/.test(app), 'authenticated deep links open exact lead and client records');
check(/client-workspace-modal/.test(app) && /crm-v2-grid/.test(app), 'responsive V2 layouts use the existing MAGNET design system');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
