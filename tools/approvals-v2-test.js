#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260826065142_approval_commands_v2.sql'), 'utf8');
const sideEffects = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260826075943_approval_side_effects_v2.sql'), 'utf8');
const staging = fs.readFileSync(path.join(root, 'tools', 'test-staging-approvals-v2.js'), 'utf8');

const checks = [];
function check(condition, label) {
  checks.push({ condition: !!condition, label });
  if (!condition) process.stderr.write(`FAIL: ${label}\n`);
}

check(/create or replace function public\.transition_approval_v2\s*\(/i.test(migration), 'server approval command exists');
check(/for update\s*;/i.test(migration), 'approval source row is locked');
check(/approval_status_conflict/i.test(migration), 'stale approval status is rejected');
check(/has_org_capability\(p_organization_id,'approvals\.manage'\)/i.test(migration), 'canonical approval capability is enforced');
check(/has_org_capability\(p_organization_id,'hr\.manage'\)/i.test(migration), 'HR time-off approval is supported');
check(/has_org_capability\(p_organization_id,'finance\.manage'\)/i.test(migration), 'finance approval is supported');
check(/insert into public\.approval_events_v2/i.test(migration), 'append-only approval event is written');
check(/insert into public\.audit_events/i.test(migration), 'canonical audit event is written');
check(/insert into public\.user_notifications_v2/i.test(migration), 'requester notification is written');
check(/records_approval_side_effects_v2/i.test(sideEffects), 'approval side effects are transaction-bound');
check(/new\.coll='deliverables'/i.test(sideEffects) && /'revisions'/i.test(sideEffects), 'revision requests create the legacy revision projection');
check(/Lateness Report/i.test(sideEffects) && /'attendance'/i.test(sideEffects), 'approved lateness creates or updates attendance');
check(/revoke all on function public\.transition_approval_v2[^;]+from public,anon/i.test(migration), 'anonymous RPC execution is revoked');
check(/function canTransitionApproval\(/.test(app), 'UI uses canonical capability gate');
check(/workspaceRpc\(cfg\.current,'transition_approval_v2'/.test(app), 'UI awaits the server approval RPC');
check(/p_expected_status:item\.status/.test(app), 'UI sends expected status for conflict protection');
check(/const approveRequest = async/.test(app) && /const approveDeliverable = async/.test(app), 'request and deliverable decisions are asynchronous');
check(/const requestRevision = async/.test(app) && /'REQUEST_CHANGES'/.test(app), 'deliverable revision decisions await the server command');
check(/ctx\.approveDocument\('proposals',p\)/.test(app) && /ctx\.approveDocument\('invoices',i\)/.test(app), 'proposal and invoice approvals use the server command');
check(/disabled=\$\{busy\}/.test(app) || /disabled=\$\{!!busy\}/.test(app), 'approval controls expose a saving state');
check(/Approvals V2 Staging E2E/.test(staging) && /rollback;/.test(staging), 'live Staging canary is rollback-only');
check(!/PRODUCTION_REF\s*=\s*['"]xqqgbvigfojfydzfguan/.test(staging), 'Staging canary does not identify Staging as Production');

const failed = checks.filter((item) => !item.condition);
if (failed.length) {
  process.stderr.write(`Approvals V2: ${checks.length - failed.length} passed, ${failed.length} failed.\n`);
  process.exit(1);
}
process.stdout.write(`Approvals V2: ${checks.length} passed, 0 failed.\n`);
