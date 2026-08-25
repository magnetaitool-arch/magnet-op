#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825170000_tenant_scoped_records_rls.sql');
const deleteMigration = read('supabase/migrations/20260825174200_record_soft_delete_command.sql');
const app = read('index.html');
const intake = read('api/intake.js');
const intakeCore = read('server/public-intake.js');
const intakeMigration = read('supabase/migrations/20260825203000_transactional_public_intake.sql');
const publicForm = read('api/public-form.js');
const accounts = read('supabase/functions/accounts/index.ts');
let passed = 0;
let failed = 0;
const check = (value, label) => {
  if (value) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
};

console.log('[1] authoritative tenant ownership');
check(/records\s+add column if not exists organization_id uuid/i.test(migration), 'records has authoritative organization_id');
check(/alter column organization_id set not null/i.test(migration), 'tenant ownership becomes mandatory after backfill');
check(/record organization_id is immutable/i.test(migration), 'record tenant cannot be moved by an update');
check(/records_sync_tenant_map/i.test(migration), 'legacy tenant map stays synchronized');
check(!/\b(delete|truncate)\s+from\s+public\.records\b/i.test(migration), 'migration does not delete business records');

console.log('\n[2] RLS and legacy surface lockdown');
check(/revoke all privileges on public\.records from public, anon, authenticated/i.test(migration), 'anonymous records grants are revoked');
check(/records_authenticated_select/i.test(migration) && /records_can_read/i.test(migration), 'reads use live database authorization');
check(/records_authenticated_insert/i.test(migration) && /records_can_write/i.test(migration), 'inserts use live database authorization');
check(/records_authenticated_update/i.test(migration), 'updates use live database authorization');
check(!/create policy\s+\w*delete/i.test(migration), 'authenticated hard delete policy is absent');
check(/records_backup_001/.test(migration) && /revoke all privileges on public\.%I from public, anon, authenticated/i.test(migration), 'legacy backup tables are quarantined');
check(/p_collection in \('_accounts', '_ratelimit', '_config'\)/i.test(migration), 'system collections are unavailable to browser roles');

console.log('\n[3] role and sensitive-data matrix');
check(/clients\.read/.test(migration) && /clients\.manage/.test(migration), 'CRM access is capability-gated');
check(/hr\.sensitive\.read/.test(migration), 'sensitive HR access is explicitly gated');
check(/finance\.read/.test(migration) && /finance\.manage/.test(migration), 'finance access is explicitly gated');
check(/member_role = 'client'/.test(migration) && /record_matches_current_client/.test(migration), 'client records are client-scoped');
check(/record_matches_current_user/.test(migration), 'employee-owned records have server-side self scope');

console.log('\n[4] browser and public-server boundary');
check(/tenantRecord\(\{ id:rec\.id, coll, data:rec \}\)/.test(app), 'browser writes include selected organization');
check(/tenantQuery\('records\?select=\*/.test(app), 'browser reads explicitly filter selected organization');
check(/filter:'organization_id=eq\.'/.test(app), 'Realtime subscription is tenant-filtered');
check(/SUPABASE_SERVICE_ROLE_KEY/.test(intakeCore) && /service_not_configured/.test(intakeCore), 'public intake fails closed without server credentials');
check(/submit_public_intake/.test(intakeCore) && /p_organization_id/.test(intakeCore)
  && /insert into public\.records \(id, coll, data, organization_id\)/i.test(intakeMigration), 'public intake stamps tenant ownership transactionally');
check(/campaign\.get/.test(publicForm) && /brief\.submit/.test(publicForm), 'public campaign and brief access use a server route');
check(/submit_public_brief/.test(publicForm) && /submit_public_brief/.test(migration), 'brief submission is transactional');
check(/organization_id:row\.organization_id\|\|organizationId/.test(accounts), 'legacy account service writes tenant ownership');

console.log('\n[5] recoverable deletion and retention');
check(/create or replace function public\.soft_delete_record/.test(deleteMigration), 'authorized soft-delete command exists');
check(/record\.soft_delete/.test(deleteMigration) && /insert into public\.audit_events/.test(deleteMigration), 'soft deletes emit immutable audit events');
check(/deleted_at is null[\s\S]*records_can_read/.test(deleteMigration), 'browser RLS hides tombstones');
check(/create or replace function public\.prune_ephemeral_records/.test(deleteMigration) && /activityLogs[\s\S]*notifications/.test(deleteMigration), 'retention command is limited to ephemeral collections');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
