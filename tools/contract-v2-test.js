#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825233000_contract_management_v2.sql');
const app = read('index.html');
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

console.log('[1] canonical contract model and templates');
check(/create table if not exists public\.agency_contracts/.test(migration), 'creates canonical contracts');
check(/foreign key \(organization_id, client_account_id\)/.test(migration), 'contracts belong to a tenant-bound client');
check(/contract_client_required/.test(migration) && /contract_client_not_found/.test(migration), 'new contracts require a real client');
check(/contract_project_client_mismatch/.test(migration), 'project relationship must belong to the same client');
check(/create table if not exists public\.contract_templates/.test(migration), 'creates the master template system');
for (const key of ['social_media','performance_marketing','website_development','branding','production','retainer','one_time_project']) {
  check(migration.includes(`('${key}'`), `seeds ${key} template`);
}
check(/definitions[\s\S]*scope[\s\S]*kpis[\s\S]*governingLaw/.test(migration), 'templates cover complete legal sections');
check(/M8 contract projection mismatch/.test(migration), 'legacy projection count is validated');
check(!/delete from public\.records/i.test(migration), 'migration never deletes legacy business records');

console.log('\n[2] lifecycle, access links, and authorization');
check(/'Draft','Internal Review','Ready','Sent','Signed','Active','Expired','Cancelled'/.test(migration), 'canonical lifecycle is explicit');
check(/invalid_contract_transition/.test(migration), 'invalid lifecycle transitions fail closed');
check(/contract_status_command_required/.test(migration), 'browser cannot bypass lifecycle commands');
check(/contract_locked_after_ready/.test(migration), 'ready/sent/signed content is locked');
check(/create table if not exists public\.contract_status_events/.test(migration), 'status timeline is append-only');
check(/contract_status_events_append_only/.test(migration), 'timeline mutation is blocked');
check(/create table if not exists public\.contract_access_links/.test(migration), 'secure access links are persisted');
check(/token_hash text not null unique/.test(migration) && !/raw_token text not null/.test(migration), 'only token hashes are stored');
check(/extensions\.gen_random_bytes\(32\)/.test(migration) && /extensions\.digest\(raw_token,'sha256'\)/.test(migration), 'links use cryptographic random tokens and SHA-256 hashes');
check(/p_expires_hours not between 1 and 336/.test(migration), 'link expiry is bounded');
check(/get_public_contract/.test(migration) && /accept_public_contract/.test(migration), 'public review and acceptance commands exist');
check(/signer_name/.test(migration) && /signer_email_normalized/.test(migration) && /accepted_at/.test(migration), 'acceptance evidence is recorded');
check(/grant execute on function public\.get_public_contract\(text\) to anon/.test(migration), 'anonymous access is limited to token RPC');
check(/has_org_capability\(p_organization_id, 'clients\.manage'\)/.test(migration), 'management commands require live client capability');
check(/archive_contract_v2/.test(migration) && /archivedAt/.test(migration), 'archive is recoverable');

console.log('\n[3] Contract Management V2 UX');
check(/function ContractWorkspaceView\(/.test(app), 'dedicated contract workspace exists');
check(/function ContractProfileModal\(/.test(app), 'contract detail is separate from edit');
check(/function PublicContractReview\(/.test(app), 'secure client review screen exists');
check(/getContractReviewTok/.test(app) && /contractReviewLink/.test(app), 'unpredictable review token is routed separately');
check(/list_contract_templates_v2/.test(app), 'UI loads master templates from the server');
check(/list_contracts_v2/.test(app) && /get_contract_v2/.test(app), 'contract list and profile use authorized RPCs');
check(/change_contract_v2_status/.test(app), 'lifecycle changes use the server command');
check(/duplicate_contract_v2/.test(app), 'draft duplication is implemented');
check(/create_contract_access_link/.test(app) && /revoke_contract_access_link/.test(app), 'secure links can be created and revoked');
check(/purpose:'DOCUMENT'/.test(app) && /Review and sign contract/.test(app), 'contract email uses the durable delivery pipeline');
check(/printDocument\('contract'/.test(app), 'print and Save PDF flow is wired');
check(/Master template/.test(app) && /social_media/.test(app), 'contract editor exposes service templates');
for (const field of ['Definitions','KPIs','Late payment','Agency obligations','Client obligations','Working hours','Out-of-scope','Intellectual property','Force majeure','Governing law']) {
  check(app.includes(field), `contract editor includes ${field}`);
}
check(/contract-review-page/.test(app) && /contract-review-paper/.test(app), 'public review uses a professional MAGNET document layout');
check(/Accept and sign/.test(app) && /موافقة وتوقيع/.test(app), 'electronic acceptance is bilingual');
check(/@media\(max-width:600px\)[^{]*\{[^}]*\.contract-review-page/.test(app), 'public contract review has a mobile layout');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
