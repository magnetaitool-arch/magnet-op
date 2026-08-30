#!/usr/bin/env node
'use strict';

// Offline M1 regression gate. It validates the committed identity contract but
// deliberately makes no network calls and does not claim that Staging is live.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
let passed = 0;
let failed = 0;
const check = (condition, message) => {
  if (condition) { passed++; console.log('  ok   ' + message); }
  else { failed++; console.log('  FAIL ' + message); }
};

const identitySql = read('supabase/migrations/20260825112900_m1_identity_context_mfa.sql');
const commandSql = read('supabase/migrations/20260825114648_identity_admin_commands.sql');
const compatibilitySql = read('supabase/migrations/20260825153000_sync_legacy_role_from_identity_command.sql');
const firstLoginSql = read('supabase/migrations/20260825160000_reconcile_legacy_login_identity.sql');
const roleSyncSql = read('supabase/migrations/20260825163000_clear_legacy_access_on_canonical_role_change.sql');
const triggerSql = read('supabase/migrations/20260825115306_secure_auth_profile_trigger.sql');
const attachSql = read('supabase/migrations/20260825120129_attach_auth_profile_trigger.sql');
const auditSql = read('supabase/migrations/20260825120600_preserve_audit_identity_history.sql');
const edge = read('supabase/functions/identity/index.ts');
const accountsEdge = read('supabase/functions/accounts/index.ts');
const stagingReconciliation = read('tools/reconcile-staging-identity.js');
const restoredAuthTest = read('tools/test-staging-auth-placeholder-repair.js');
const html = read('index.html');
const pkg = JSON.parse(read('package.json'));

console.log('[1] canonical identity database contract');
for (const table of ['login_aliases', 'mfa_factors', 'mfa_challenges', 'trusted_devices', 'auth_rate_limits']) {
  check(new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(identitySql), `creates ${table}`);
}
check(/current_identity_context\(\)/i.test(identitySql), 'live identity context is resolved by the database');
check(/membership\.user_id = auth\.uid\(\)/i.test(identitySql), 'membership checks bind to the JWT subject');
check(/profile\.identity_status = 'ACTIVE'/i.test(identitySql), 'inactive profiles fail membership checks');
check(/capability\.key = lower\(btrim\(p_capability\)\)/i.test(identitySql), 'capabilities are checked live');
check(/revoke all on function public\.current_identity_context\(\) from public, anon/i.test(identitySql), 'identity RPC is unavailable to anonymous users');
check(/grant execute on function public\.current_identity_context\(\) to authenticated, service_role/i.test(identitySql), 'identity RPC is available only to authenticated/server contexts');

console.log('\n[2] MFA and device safety');
check(/code_hash text not null/i.test(identitySql), 'OTP challenges store a hash');
check(!/\b(code|otp)\s+text\s+not\s+null/i.test(identitySql), 'no plaintext OTP column exists');
check(/expires_at timestamptz not null/i.test(identitySql), 'OTP challenges expire');
check(/attempt_count integer not null default 0/i.test(identitySql) && /max_attempts integer not null default 5/i.test(identitySql), 'OTP attempts are bounded');
check(/status in \('PENDING','VERIFIED','EXPIRED','LOCKED','CANCELLED'\)/i.test(identitySql), 'OTP lifecycle is explicit');
check(/unique \(scope, subject_hash\)/i.test(identitySql), 'authentication rate limits are keyed by pseudonymous subject');
check(/device_hash text not null/i.test(identitySql) && !/device_fingerprint\s+text/i.test(identitySql), 'trusted devices store hashes instead of raw fingerprints');

console.log('\n[3] transactional identity administration');
check(/security definer/i.test(commandSql), 'membership command executes in a controlled server context');
check(/capability\.key = 'members\.manage'/i.test(commandSql), 'membership changes require members.manage');
check(/active_owner_count <= 1/i.test(commandSql), 'last active owner cannot be removed');
check(/set session_epoch = session_epoch \+ 1/i.test(commandSql), 'role/status changes invalidate live session context');
check(/insert into public\.audit_events/i.test(commandSql), 'membership changes create an immutable audit event');
check(/revoke all on function public\.identity_update_membership[\s\S]*from public, anon, authenticated/i.test(commandSql), 'browser roles cannot execute the service command directly');
check(/link_status = 'CONFIRMED'/i.test(compatibilitySql), 'legacy compatibility sync requires an explicitly confirmed identity link');
check(/update public\.records legacy_account/i.test(compatibilitySql) && /legacy_account\.coll = '_accounts'/i.test(compatibilitySql), 'canonical role command synchronizes only its linked legacy account');
check(/'access'[\s\S]*else '\{\}'::jsonb/i.test(compatibilitySql), 'role changes clear stale per-role browser overrides');
check(/auth\.role\(\) <> 'service_role'/i.test(firstLoginSql), 'first-login reconciliation is service-only');
check(/lower\(btrim\(coalesce\(account_data->>'email'/i.test(firstLoginSql), 'first-login link requires matching normalized email');
check(/on conflict \(organization_id, user_id\) do nothing/i.test(firstLoginSql), 'first login never overwrites an existing canonical membership');
check(/identity_link_conflict/i.test(firstLoginSql) && /identity_alias_conflict/i.test(firstLoginSql), 'identity and alias conflicts fail closed');
check(/case when existing_link_confirmed then identity_status else 'ACTIVE' end/i.test(firstLoginSql), 'a confirmed disabled identity cannot reactivate itself through legacy login');
check(/old\.role_id is distinct from new\.role_id then '\{\}'::jsonb/i.test(roleSyncSql), 'canonical role transitions always clear stale legacy access overrides');
check(/link_status = 'CONFIRMED'/i.test(roleSyncSql), 'membership trigger touches only confirmed legacy identity links');

console.log('\n[4] Auth profile provisioning');
check(/new\.id[\s\S]*new\.email/i.test(triggerSql), 'new Supabase users receive a canonical profile');
check(/'PENDING_SETUP'[\s\S]*'PENDING'/i.test(triggerSql), 'new identities start in pending onboarding state');
check(!/raw_user_meta_data[\s\S]{0,180}\brole\b/i.test(triggerSql), 'untrusted signup metadata cannot select a role');
check(/after insert on auth\.users/i.test(attachSql), 'Auth user provisioning trigger is attached');
check(/drop constraint if exists auth_events_user_id_fkey/i.test(auditSql), 'identity deletion cannot rewrite immutable auth history');
check(/drop constraint if exists audit_events_actor_user_id_fkey/i.test(auditSql), 'identity deletion cannot rewrite immutable audit history');

console.log('\n[5] Edge authorization boundary');
check(/\/auth\/v1/.test(edge) && /authenticatedUser\(jwt\)/.test(edge), 'Edge service validates the Supabase access token');
check(!/legacy[^\n]{0,40}token/i.test(edge.replace(/The legacy account token is never accepted here\./, '')), 'Edge service never accepts a legacy account token');
check(/ALLOWED_ORIGINS\.has\(origin\)/.test(edge), 'CORS uses an exact origin allowlist');
check(/action === 'context'/.test(edge), 'context endpoint is present');
check(/hasCapability\(context, organizationId, 'members\.manage'\)/.test(edge), 'member directory and writes are capability-gated');
check(/rpc\/identity_update_membership/.test(edge), 'role changes use the transactional database command');
check(/legacy_identity_links/.test(edge) && /legacyUserId/.test(edge), 'member directory returns stable confirmed cutover links');
check(!/console\.error\([^\n]*(jwt|email|password|token)/i.test(edge), 'Edge logs do not print credentials or personal identity values');
check(/reconcileLegacyIdentity\(au\.id,rec\.rowId\)/.test(accountsEdge), 'legacy password login must reconcile canonical identity before issuing a session');
check(/linkedAuthUserId\(rec\.rowId\)/.test(accountsEdge), 'repeat login resolves the immutable identity link before provider email discovery');
check(/if\(!linkedUserId\)\{[\s\S]{0,220}reconcileLegacyIdentity\(au\.id,rec\.rowId\)/.test(accountsEdge), 'confirmed identity links do not rerun first-login alias reconciliation');
check(/adminDeleteUser\(au\.id\)/.test(accountsEdge), 'failed new-user reconciliation removes the incomplete Auth identity');
check(/provider_password_update_failed/.test(accountsEdge), 'failed provider password updates fail closed');
check(/providerPassword\(pw:string\)[\s\S]{0,220}hmac\('provider-password:'/.test(accountsEdge), 'legacy credentials are converted to a server-derived provider password');
check(/session=await passwordGrant\(email, body\.password\);[\s\S]{0,650}adminSetPassword\(au\.id, upgradedPassword\)/.test(accountsEdge), 'repeat login checks existing credentials before applying a policy-compatible provider repair');
check(/adminCreateUser\(email, upgradedPassword\)/.test(accountsEdge), 'first login supports legacy passwords that do not meet the provider password policy');
check(/confirmation_token = coalesce\(auth_user\.confirmation_token, ''\)/.test(stagingReconciliation)
  && /recovery_token = coalesce\(auth_user\.recovery_token, ''\)/.test(stagingReconciliation)
  && /email_change_token_new = coalesce\(auth_user\.email_change_token_new, ''\)/.test(stagingReconciliation)
  && /email_change = coalesce\(auth_user\.email_change, ''\)/.test(stagingReconciliation),
'restored passwordless identities normalize legacy provider token columns before first login');
check(/PROTECTED_PROJECT_REFS/.test(restoredAuthTest) && /refused_non_staging|explicit non-Production/.test(restoredAuthTest)
  && /magnet_auth_repair_canary/.test(restoredAuthTest), 'restored Auth regression test is Staging-only and disposable');

console.log('\n[6] browser cutover contract');
check(/loadCanonicalIdentity\(cfg\.current,res\.user\)/.test(html), 'login resolves canonical identity before opening private data');
check(/organization_selection_required/.test(html), 'multi-organization ambiguity fails closed');
check(/authUserId:context\.userId/.test(html), 'the UI retains immutable Supabase user id');
check(/role:canonicalRoleName\(membership\)/.test(html), 'the displayed role comes from live membership');
check(/return; \/\/ a canonical session must never be overwritten by a legacy role snapshot/.test(html), 'legacy refresh cannot overwrite a canonical role');
check(/\[401,403,409\]\.includes/.test(html), 'inactive or unresolved identity closes the local session');

console.log('\n[7] runnable verification');
check(pkg.scripts && pkg.scripts['test:identity'], 'offline identity test is registered');
check(pkg.scripts && pkg.scripts['test:identity:staging'], 'Staging identity E2E is registered');
check(pkg.scripts && pkg.scripts['test:login:staging'], 'Staging full login cutover test is registered');
check(pkg.scripts && pkg.scripts['test:auth-repair:staging'], 'Staging restored Auth repair test is registered');
check(pkg.scripts && pkg.scripts['diagnose:auth:staging'], 'Staging identity diagnostic is registered');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
