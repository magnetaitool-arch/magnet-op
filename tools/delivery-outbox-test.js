#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825210000_reliable_delivery_outbox.sql');
const server = read('server/outbox.js');
const app = read('index.html');
let passed = 0;
let failed = 0;
const check = (condition, label) => {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
};

console.log('[1] durable queue and immutable attempts');
check(/outbox_delivery_attempts/.test(migration), 'creates delivery attempt history');
check(/outbox_delivery_attempts_append_only/.test(migration) && /prevent_event_mutation/.test(migration), 'delivery attempts are append-only');
check(/correlation_id uuid not null/.test(migration), 'outbox messages have correlation IDs');
check(/'ACCEPTED','DELIVERED'/.test(migration), 'provider acceptance is distinct from confirmed delivery');
check(/attempt_count < message\.max_attempts/.test(migration) && /for update skip locked/i.test(migration), 'worker claims are leased and bounded');
check(/5 minutes[\s\S]*30 minutes[\s\S]*2 hours[\s\S]*12 hours/.test(migration), 'failed deliveries use bounded exponential backoff');

console.log('\n[2] server authorization and provider boundary');
check(/enqueue_email_message/.test(server) && /Bearer '\s*\+ token/.test(server), 'browser email is enqueued with the Supabase JWT');
check(/authenticated_session_required/.test(server), 'anonymous browser email fails closed');
check(/x-outbox-secret/.test(server) && /worker_secret_required/.test(server), 'worker drain requires a server secret');
check(/RESEND_API_KEY/.test(server) && /WHATSAPP_ACCESS_TOKEN/.test(server), 'provider credentials stay in server environment variables');
check(!/console\.(log|error)\(/.test(server), 'delivery server does not log message bodies or credentials');

console.log('\n[3] database capability enforcement');
for (const purpose of ['TASK_ASSIGNMENT','PAYSLIP','EMPLOYEE_REPORT','USER_ADMIN','DOCUMENT','NOTIFICATION','SYSTEM_TEST']) {
  check(new RegExp(`when '${purpose}'`).test(migration), `${purpose} has an explicit capability rule`);
}
check(/revoke all on function public\.enqueue_email_message[\s\S]*from public, anon/i.test(migration), 'anonymous users cannot enqueue email');
check(/grant execute on function public\.enqueue_email_message[\s\S]*to authenticated/i.test(migration), 'authenticated enqueue is mediated by the database command');
check(/p_organization_id uuid/.test(migration) && /membership\.organization_id = target_organization_id/.test(migration), 'enqueue uses the explicitly selected active tenant');
check(/revoke all on function public\.claim_outbox_messages[\s\S]*authenticated/i.test(migration), 'browser roles cannot claim provider work');

console.log('\n[4] client delivery state');
check(/'Authorization':'Bearer '\+token/.test(app), 'browser sends its access token to the email route');
check(/emailEventStatus[\s\S]*Queued[\s\S]*Processing/.test(app), 'UI understands queued and processing states');
check(/purpose:'TASK_ASSIGNMENT'/.test(app) && /purpose:'PAYSLIP'/.test(app) && /purpose:'USER_ADMIN'/.test(app), 'high-risk email actions declare their purpose');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
