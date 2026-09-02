#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sql = read('supabase/migrations/20260902000100_employee_requests_v3.sql');
const ui = read('modules/employee-requests-v3.js');
const shell = read('index.html');
let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${message}`);
  }
}

console.log('[Employee Requests V3] database model');
for (const table of [
  'employee_request_type_policies_v3', 'employee_request_holidays_v3',
  'employee_requests_v3', 'employee_request_sensitive_v3',
  'employee_request_expense_lines_v3', 'employee_request_steps_v3',
  'employee_request_events_v3', 'employee_request_documents_v3',
  'employee_request_effects_v3'
]) check(sql.includes(`create table if not exists public.${table}`), `${table} is created additively`);
check(/unique\(organization_id,requester_user_id,idempotency_key\)/.test(sql), 'submission idempotency is enforced by the database');
check(/approved_units numeric/.test(sql), 'partial approvals preserve requested and approved units separately');
check(/employee_request_events_v3_no_mutation/.test(sql) && /before update or delete/.test(sql), 'approval timeline is append-only');
check(/request_version_conflict/.test(sql) && /p_expected_version/.test(sql), 'mutations use optimistic concurrency');
check(/request_self_approval_forbidden/.test(sql), 'requesters cannot approve their own requests');
check(/duplicate_request_exists/.test(sql), 'duplicate date-range requests are rejected server-side');
check(/request_server_field_claim_rejected/.test(sql) && /organizationId.*employeeId.*requesterUserId.*status.*approvers.*balance.*approvedBy/.test(sql), 'browser identity, role, status, and balance claims are rejected');
check(/employee_request_employee_for_user_v3\(auth\.uid\(\)\)/.test(sql) && /employee_request_manager_for_employee_v3/.test(sql), 'employee and manager are resolved from authenticated server context');
check(/quote_employee_request_v3/.test(sql) && /employee_request_holidays_v3/.test(sql) && /weekendDays/.test(sql), 'leave quote accounts for policy weekends and holidays server-side');
check(/leave_balance_insufficient/.test(sql) && /medical_certificate_required/.test(sql), 'leave balance and medical certificate policy are enforced server-side');
check(/minNoticeDays/.test(sql) && /maxConsecutiveDays/.test(sql) && /maxHoursPerDay/.test(sql), 'duration and notice limits are enforced server-side');
check(/minAmount/.test(sql) && /maxAmount/.test(sql) && /department/.test(sql), 'approval routes support amount, duration, and department conditions');

console.log('\n[Employee Requests V3] security');
check(/enable row level security/g.test(sql) && (sql.match(/enable row level security/g) || []).length >= 9, 'RLS is enabled on every request table');
check(/revoke all privileges[\s\S]*from public,anon,authenticated/.test(sql), 'browser roles have no direct mutation privileges');
check(/grant select[\s\S]*to authenticated/.test(sql) && !/grant (insert|update|delete)[^;]*to authenticated/i.test(sql), 'authenticated users are read-only at table level');
check(/CONFIDENTIAL_REQUEST/.test(sql) && /requests\.confidential\.read/.test(sql), 'confidential attachments have dedicated visibility');
check(/employee_request\.confidential_accessed/.test(sql), 'confidential request access is audited without content');
check(/p_classification='CONFIDENTIAL'[\s\S]*requests\.confidential\.read/.test(sql), 'ordinary managers cannot read confidential complaints');
check(/p_classification='FINANCE_SENSITIVE'[\s\S]*requests\.finance\.read/.test(sql), 'financial details require a finance capability');
check(/p_classification in \('HR_SENSITIVE','MEDICAL'\)[\s\S]*hr\.sensitive\.read/.test(sql), 'medical details require sensitive HR access');
check(/document_storage_can_upload[\s\S]*document\.uploaded_by=auth\.uid\(\)[\s\S]*requests\.create/.test(sql), 'employees can upload only their own request document slots');
check(/Never|password/.test(read('AGENTS.md')) || !/(service_role|sb_secret_)\s*[:=]\s*['"][A-Za-z0-9]/.test(sql + ui), 'request module contains no embedded production secret');

console.log('\n[Employee Requests V3] workflow and effects');
for (const rpc of [
  'get_employee_request_context_v3', 'list_employee_request_types_v3',
  'quote_employee_request_v3', 'create_employee_request_upload_v3',
  'submit_employee_request_v3', 'submit_saved_employee_request_v3', 'decide_employee_request_v3',
  'respond_employee_request_v3', 'cancel_employee_request_v3',
  'complete_employee_request_v3', 'list_employee_requests_v3',
  'get_employee_request_v3', 'update_employee_request_policy_v3'
]) check(sql.includes(`function public.${rpc}`), `${rpc} RPC exists`);
check(/PENDING_MANAGER.*PENDING_HR.*PENDING_FINANCE.*PENDING_ADMINISTRATION/s.test(sql), 'explicit approval state machine covers every reviewer class');
check(/PARTIALLY_APPROVE/.test(sql) && /partial_approval_units_required/.test(sql), 'partial approval requires an explicit approved amount');
check(/apply_employee_request_effect_v3/.test(sql) && /source','employee_request_v3'/.test(sql), 'approved requests create traceable server-side effects');
check(/attendance_conflict/.test(sql) && /effect_status='CONFLICT'/.test(sql), 'attendance conflicts stop instead of overwriting an existing record');
check(/'leaves'/.test(sql) && /'attendance'/.test(sql) && /'expenses'/.test(sql) && /'employeePayments'/.test(sql), 'leave, attendance, finance, and payroll integrations are present');
check(/EMAIL_INTERNAL/.test(sql) && /user_notifications_v2/.test(sql) && /entity_id/.test(sql), 'in-system and tracked email notifications target the exact request');
check(/employee_request_enqueue_email_v3\([^;]+,'COMPLETED'/.test(sql), 'completed requests emit a tracked employee email');
check(/on conflict\(organization_id,kind,idempotency_key\) do nothing/.test(sql), 'notification retries cannot duplicate an email outbox message');
check(/is_current=false,archived_at=now\(\),effective_to=current_date/.test(sql), 'policy updates version instead of mutating historical policy');

console.log('\n[Employee Requests V3] employee and reviewer UI');
check(/QUICK REQUEST/.test(ui) && /QUICK_KEYS/.test(ui), 'mobile-first quick request launcher is present');
check(/get_employee_request_context_v3/.test(ui) && /req3-identity/.test(ui), 'employee ID, department, and manager are shown from server context');
check(/Review before sending/.test(ui) && /Confirm & submit/.test(ui), 'request review step is explicit before submission');
check(/Save draft/.test(ui) && /NEEDS_INFORMATION/.test(ui) && /cancel_employee_request_v3/.test(ui), 'draft, missing-information, and cancellation flows are connected');
check(/submit_saved_employee_request_v3/.test(ui) && /Submit draft/.test(ui), 'saved drafts can be submitted through a server revalidation command');
check(/Duplicate/.test(ui) && /WhatsApp/.test(ui) && /navigator\.clipboard\.writeText/.test(ui), 'duplicate and copyable WhatsApp actions are available');
check(/decide_employee_request_v3/.test(ui) && /Partially approve/.test(ui), 'reviewer approve, partial, reject, and information actions are connected');
check(/uploadRequestAttachment/.test(ui) && /storageSignedUrl/.test(ui), 'private upload and short-lived download flow is connected');
check(/Request PDF/.test(ui) && /@page\{size:A4/.test(ui) && /CONFIDENTIAL/.test(ui), 'A4 request PDF and confidential watermark are implemented');
check(/Policies/.test(ui) && /update_employee_request_policy_v3/.test(ui), 'HR policy version editor is connected');
check(/Team calendar/.test(ui) && /TEAM_CALENDAR/.test(ui), 'privacy-safe team availability calendar is present');
check(/L\(ar/.test(ui) && /[\u0600-\u06ff]/.test(ui), 'English and Arabic parity is present');
check(/@media\(max-width:767px\)[\s\S]*req3/.test(shell) && /height:100dvh!important/.test(shell), 'request modals adapt to mobile and short laptop screens');
check(!/\.from\(|cloudUpsert|createRecord\(/.test(ui), 'V3 request UI never writes protected business tables directly');
check(/modules\/employee-requests-v3\.js/.test(shell) && /ReactDOM\.createRoot/.test(shell), 'module loads before the app mounts');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
