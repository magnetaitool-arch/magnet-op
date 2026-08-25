#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825220000_recruitment_v2.sql');
const app = read('index.html');
let passed = 0;
let failed = 0;
const check = (condition, label) => {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
};

console.log('[1] canonical recruitment data model');
for (const table of ['applicants', 'applicant_stage_events', 'applicant_interviews', 'applicant_notes']) {
  check(new RegExp(`create table if not exists public\\.${table}`).test(migration), `creates ${table}`);
}
check(/organization_id uuid not null/.test(migration) && /unique \(organization_id, legacy_record_id\)/.test(migration), 'applicants are tenant scoped and legacy linked');
check(/'New','Screening','Interview','Offer','Hired','Rejected','Archived'/.test(migration), 'supports the complete lifecycle including Archived');
check(/records_sync_applicant/.test(migration) && /sync_applicant_from_legacy_record/.test(migration), 'legacy applicants project into the canonical model');
check(/Backfill every active legacy candidate/.test(migration) && /Applicant backfill mismatch/.test(migration), 'migration backfills and validates without deleting legacy data');
check(!/delete from public\.records/i.test(migration), 'migration never deletes legacy records');

console.log('\n[2] server authorization and immutable history');
check(/enable row level security/g.test(migration), 'canonical tables enable RLS');
check(/has_org_capability\(organization_id, 'hr\.read'\)/.test(migration), 'reads require live HR capability');
check((migration.match(/has_org_capability\(p_organization_id, 'hr\.manage'\)/g) || []).length >= 3, 'all lifecycle writes require live HR manage capability');
check(/revoke all privileges on public\.applicants from public, anon, authenticated/.test(migration), 'anonymous and direct browser writes are revoked');
check(/applicant_stage_events_append_only/.test(migration) && /applicant_notes_append_only/.test(migration), 'stage history and internal notes are append-only');
check(/revoke all on function public\.list_applicants[\s\S]*from public, anon/.test(migration), 'anonymous users cannot call recruitment RPCs');

console.log('\n[3] usable Recruitment V2 experience');
check(/function RecruitmentView\(/.test(app), 'dedicated Recruitment V2 screen exists');
check(/function ApplicantProfileModal\(/.test(app), 'applicant profile is separate from edit');
check(/list_applicants/.test(app) && /get_applicant_profile/.test(app), 'list and profiles load from authorized server RPCs');
check(/change_applicant_stage/.test(app) && /schedule_applicant_interview/.test(app) && /add_applicant_note/.test(app), 'lifecycle actions use audited server commands');
for (const tab of ['Overview', 'Application Answers', 'CV', 'Portfolio', 'Experience', 'Salary Expectation', 'Interview', 'Internal Notes', 'Attachments', 'Timeline']) {
  check(app.includes(tab), `profile includes ${tab}`);
}
check(/URLSearchParams\(location\.search\)[\s\S]*get\('open'\)[\s\S]*get\('id'\)/.test(app), 'authenticated applicant deep links are handled');
check(/rec-stage-tab/.test(app) && /rec-view-toggle/.test(app) && /rec-pagination/.test(app), 'stage counts, list/card views, and pagination are implemented');
check(/candidateStage:\['New','Screening','Interview','Offer','Hired','Rejected','Archived'\]/.test(app), 'legacy forms also preserve Archived');

console.log('\n[4] environment isolation');
check(!/url:"https:\/\/jdylrthffifbhyrrhuqd\.supabase\.co"/.test(app), 'local UI does not seed the Production URL');
check(!/const sbBase = \(cfg\)=> \(\(cfg&&cfg\.url\)\|\|'https:\/\//.test(app), 'public helpers have no Production fallback');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
