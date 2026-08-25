#!/usr/bin/env node
// Magnet OS — offline smoke test. No network, no secrets. Verifies the codebase
// has no syntax errors and none of the known dangerous patterns regressed.
//
//   node tools/smoke-test.js        (or: npm run smoke)
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('./_lib');
const ROOT = lib.REPO_ROOT;

let fail = 0, pass = 0;
const ok = (m) => { pass++; console.log('  ok   ' + m); };
const bad = (m) => { fail++; console.log('  FAIL ' + m); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

console.log('[1] node --check on server JS');
for (const file of ['api/send-email.js', 'api/outbox.js', 'api/intake.js', 'api/public-form.js', 'api/runtime-config.js', 'server/public-intake.js', 'server/outbox.js', 'netlify/functions/intake.js', 'netlify/functions/send-email.js',
  'serviceworker.js', 'tools/_lib.js', 'tools/backup-supabase-records.js', 'tools/backup-local-data.js',
  'tools/validate-backup.js', 'tools/restore-supabase-records.js', 'tools/check-config.js',
  'tools/audit-saas-readiness.js', 'tools/diagnose-auth.js', 'tools/saas-foundation-test.js',
  'tools/identity-foundation-test.js', 'tools/tenant-foundation-test.js', 'tools/organization-settings-test.js', 'tools/employee-privacy-test.js', 'tools/public-intake-test.js', 'tools/delivery-outbox-test.js', 'tools/recruitment-v2-test.js', 'tools/sales-client-workspace-v2-test.js', 'tools/preflight-staging-migration.js',
  'tools/reconcile-staging-identity.js', 'tools/test-staging-identity.js',
  'tools/test-staging-app-login.js', 'tools/test-staging-tenant-rls.js', 'tools/test-staging-organization-settings.js', 'tools/test-staging-employee-privacy.js', 'tools/test-staging-public-forms.js', 'tools/test-staging-public-intake.js', 'tools/test-staging-delivery-outbox.js', 'tools/test-staging-recruitment-v2.js', 'tools/test-staging-sales-client-workspace-v2.js',
  'tools/m0-logical-backup.js', 'tools/m0-restore-staging.js', 'tools/m0-validate-staging.js',
  'tools/m0-security-baseline.js', 'tools/m0-configure-vercel-preview.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' }); ok(file); }
  catch (e) { bad(file + ' — ' + String(e.stderr || e).split('\n')[0]); }
}

console.log('\n[2] JSON files parse');
for (const file of ['package.json', 'manifest.json', 'vercel.json']) {
  try { JSON.parse(read(file)); ok(file); } catch (e) { bad(file + ' — ' + e.message); }
}

console.log('\n[3] accounts Edge Function hardening');
const acct = read('supabase/functions/accounts/index.ts');
/function sendMail\(/.test(acct) ? ok('sendMail is defined (forgot-password works)') : bad('sendMail NOT defined — forgot-password will 500');
// newHash must be gone OR only accepted when format-validated as PBKDF2.
(!/body\.newHash/.test(acct) || /\^pbkdf2\\\$/.test(acct))
  ? ok('accounts hashes server-side; any newHash is PBKDF2-format-validated (no arbitrary hash)')
  : bad('accounts accepts an unvalidated client body.newHash');
/return json\(\{error:'server error'\},500\)/.test(acct) ? ok('generic 500 (no internal-error leak)') : bad('top-level catch may leak internal errors');
/INITIAL_OWNER_SETUP_SECRET/.test(acct) && /setup-required/.test(acct)
  ? ok('first Owner requires a server-side setup secret')
  : bad('first Owner bootstrap is not protected by INITIAL_OWNER_SETUP_SECRET');
/next\.length<10/.test(acct) && /\!\/\[A-Z\]\//.test(acct)
  ? ok('server enforces strong new passwords')
  : bad('server password policy is weaker than the UI policy');
/RL_LOGIN_WINDOW_MS/.test(acct) && /RL_FORGOT_WINDOW_MS/.test(acct) && /reason:'rate-limited'/.test(acct)
  ? ok('login and password-recovery throttles are separate and report lockout')
  : bad('login/recovery rate limits can still block the wrong flow');
/action==='unlock'/.test(acct) && /liveActor/.test(acct)
  ? ok('owner can unlock accounts and admin rights use the live account role')
  : bad('account unlock/live-role authorization is missing');
/action==='me'/.test(acct) && /refreshCurrentUser/.test(read('index.html')) && /setInterval\(refreshIdentity,60000\)/.test(read('index.html'))
  ? ok('open sessions revalidate live role/status/access and cannot stay on a stale employee role')
  : bad('open sessions can keep a stale role after an account repair or downgrade');
/version:13/.test(acct) && /identity-conflict/.test(acct) && /uniqueByLogin/.test(acct)
  ? ok('accounts v13 fails closed on an ambiguous login instead of selecting an arbitrary role')
  : bad('accounts service can still select an arbitrary duplicate login identity');
/per_page=1000/.test(acct) && /last_page/.test(acct)
  ? ok('Supabase Auth reconciliation paginates beyond the first 200 identities')
  : bad('Supabase Auth reconciliation only scans an initial user page');
/logAuthEvent/.test(acct) && /subject_ref/.test(acct) && /login_succeeded/.test(acct) && /login_failed/.test(acct)
  ? ok('auth success/failure events are structured and pseudonymized')
  : bad('authentication failures are not safely observable');
/duplicate-email/.test(acct) && /duplicate-username/.test(acct) && /last-owner/.test(acct)
  ? ok('duplicate logins and last-owner lockout are blocked server-side')
  : bad('account identity/last-owner guards are missing');
/records_accounts_email_unique/.test(read('supabase/legacy-migrations/006_canonicalize_duplicate_logins.sql'))
  && /records_accounts_username_unique/.test(read('supabase/legacy-migrations/006_canonicalize_duplicate_logins.sql'))
  ? ok('database unique indexes make duplicate email/username identities impossible')
  : bad('database does not enforce unique login identities');

console.log('\n[4] frontend password-change hardening');
const html = read('index.html');
/changepw'?,\s*\{\s*token:getAcctToken\(\),\s*currentPassword:cur,\s*newPassword:np/.test(html.replace(/\s+/g, ' '))
  ? ok('PwResetForm sends newPassword (not a client hash)')
  : (/newHash\s*=\s*await\s+AUTH\.hashPassword/.test(html) ? bad('PwResetForm still computes/sends newHash') : ok('no client-side newHash in change-password'));

console.log('\n[5] dangerous-pattern scan');
/admin123/.test(html) ? bad('legacy default credential remains in index.html') : ok('no default credential remains in index.html');
/bootstrapOwner/.test(html) && /InitialSetupScreen/.test(html) ? ok('fresh installs use explicit owner setup') : bad('fresh-install owner setup is missing');
/isLegacyAuthFallbackAllowed/.test(html) ? ok('browser auth fallback is local-development only') : bad('browser auth fallback is not gated');
/Password must be at least 10 characters\./.test(html) ? ok('frontend enforces strong passwords') : bad('frontend password policy is weaker than expected');
/sb_secret_|service_role.{0,40}=\s*['"]eyJ/.test(html) ? bad('possible service_role/secret key in index.html') : ok('no service_role/secret key in index.html');
/\/\.netlify\/functions\/intake/.test(html) ? bad('index.html calls netlify intake (Vercel default) — use /api/intake') : ok('no hardcoded netlify intake call in index.html');
const intakeCore = read('server/public-intake.js');
const intakeMigration = read('supabase/migrations/20260825203000_transactional_public_intake.sql');
/rpc\/submit_public_intake/.test(intakeCore) && !/rest\/v1\/records/.test(intakeCore)
  ? ok('public intake uses one transactional server command instead of direct record writes')
  : bad('public intake can bypass the transactional database command');
/public_intake_rate_limits/.test(intakeMigration) && /idempotency_keys/.test(intakeMigration)
  && /outbox_messages/.test(intakeMigration) && /audit_events/.test(intakeMigration)
  ? ok('public intake is rate-limited, idempotent, audited, and durable')
  : bad('public intake reliability/security controls are incomplete');
/sendTaskAssignmentEmail\(created,false\)/.test(html) && /assignmentEmailStatus:result\.status/.test(html)
  ? ok('task assignments trigger tracked email delivery')
  : bad('task assignment email tracking is missing');
/payslipEmailStatus/.test(html) && /Confirm the salary was actually paid/.test(html)
  ? ok('payslip delivery is separated from explicit payment confirmation')
  : bad('payslip email may still be conflated with salary payment');
/attendance already exists for this employee and date/i.test(html)
  ? ok('duplicate employee/date attendance is blocked')
  : bad('duplicate attendance guard is missing');
/lateGraceMinutes/.test(html) && /workStartTime/.test(html) && /weekendDays/.test(html)
  ? ok('attendance schedule and grace are configurable')
  : bad('attendance rules are not configurable');
/emailDeliveryStatus/.test(html) && /employeeReportsAuto/.test(html)
  ? ok('employee reports support automation and tracked delivery')
  : bad('employee report automation/delivery tracking is missing');
/saveUsersConfirmed/.test(html) && /The server did not confirm the change/.test(html)
  ? ok('account administration waits for a confirmed server write')
  : bad('role/password changes can still claim success before cloud persistence');
/Linked employee/.test(html) && /Repair links & roles/.test(html) && /unlockUserConfirmed/.test(html)
  ? ok('employee-account linking, role repair, and login unlock tools are present')
  : bad('account recovery/link repair controls are missing');
/Check & sync login role/.test(html) && /loginRoleMismatch/.test(html) && /access:nextRole!==account\.role\?\{\}/.test(html)
  ? ok('employee profiles detect role drift and can sync the login role without carrying stale overrides')
  : bad('employee/login role drift still requires external repair or can retain old-role overrides');
/coll==='employees' && _prev && patch\.appRole && isAdminRole\(role\)/.test(html)
  ? ok('every Owner/Admin employee save reconciles the login account even when the profile role was already correct')
  : bad('saving an already-correct employee profile can leave a mismatched login role unchanged');
/const canonical=cloud\.filter\(u=>u&&u\.id&&!u\._del\)/.test(html) && /store\.set\(AUTH_KEYS\.users, JSON\.stringify\(canonical\)\)/.test(html)
  ? ok('successful cloud account roster replaces stale local cache so deleted logins cannot resurrect')
  : bad('cloud account sync can merge deleted local accounts back into the live roster');
!/merged\.length > \(cloud\?cloud\.length:0\)/.test(html) && /A successful authenticated cloud roster is the only account authority/.test(html)
  ? ok('startup account discovery cannot upload local-only ghost accounts')
  : bad('startup can still resurrect a deleted account from local storage');
/async function saveUserConfirmed\(user\)/.test(html) && /acctApi\(cfg,'save',\{token:getAcctToken\(\),user\}\)/.test(html)
  ? ok('single-account admin edits do not re-upload a stale full roster')
  : bad('account edits can still re-upload stale unrelated identities');
/Existing account email\/username are login identities/.test(html) && /email:isNew\?/.test(html)
  ? ok('linking an existing account never overwrites its login email from an HR typo')
  : bad('employee linking can silently replace an existing login email');
/cloudLoadDelta/.test(html) && /updated_at=gt\./.test(html) && !/setInterval\(tick,\s*5000\)/.test(html)
  ? ok('live sync uses updated_at deltas instead of 5-second full-database downloads')
  : bad('high-egress full-database polling has returned');
/__moRealtimeClient\.realtime\.setAuth/.test(html) && /client\.realtime&&client\.realtime\.setAuth/.test(html)
  ? ok('Realtime authenticates with the user JWT and rotates refreshed tokens')
  : bad('Realtime may subscribe anonymously or keep an expired JWT');
/needsSetup:accounts\.length===0/.test(acct) && /cloudAccountStatus/.test(html) && /hasCloudAccounts/.test(html)
  ? ok('fresh browsers distinguish existing accounts from first-owner setup without exposing the roster')
  : bad('fresh browsers can show first-owner setup when accounts already exist');
/required:false/.test(html) && /AUTH_V2\.required/.test(html) && /authenticated-session-required/.test(html)
  && /await loadAuthV2Flag\(cfg\.current\);\s*const res = await authLogin/.test(html)
  ? ok('mandatory Supabase Auth rollout loads its flag before login and cannot fall back to anon without a JWT')
  : bad('Auth v2 required mode can still authenticate or load private data as anon');
/authV2:await dbAuthConfig\(\)/.test(acct) && /JSON\.stringify\(\{action:'health'\}\)/.test(html)
  && !/records\?id=eq\._cfg-authv2&select=data/.test(html)
  ? ok('Auth rollout configuration comes from the server instead of an anon-readable database row')
  : bad('Auth rollout still depends on exposing server configuration through anon PostgREST');
/AUTH_V2_REQUIRED_ENV/.test(acct) && /authV2:await dbAuthConfig\(\)/.test(acct)
  && /applyAuthV2Contract\(res\.authV2\)/.test(html) && /authV2:r\.authV2/.test(html)
  ? ok('a successful login carries the server cutover contract and mandatory mode has an environment safety belt')
  : bad('login can race the Auth cutover flag or silently downgrade mandatory mode');
!/Spark Marketing/.test(html) && !/<option[^>]*value=["']TIA["']/.test(html) && !/@tia\.com/.test(html)
  && /const BRANDS = \['Magnet'\]/.test(html) && !/setBrand\(/.test(html)
  ? ok('workspace branding is Magnet-only with no legacy brand selector')
  : bad('legacy TIA/Spark branding or multi-brand selector has returned');
((html.match(/if\(!authReady \|\| !authUser \|\| !cfgComplete\(cfg\.current\)\) return;/g)||[]).length>=2)
  && (/if\(authReady&&authUser&&cfgComplete\(cfg\.current\)\)/.test(html)
    || /if\(!\(authReady&&authUser&&cfgComplete\(cfg\.current\)\)\) return/.test(html))
  ? ok('anonymous visitors cannot start full, delta, or realtime business-data sync')
  : bad('login page still downloads private business data or consumes database egress');

console.log('\n[6] inline app scripts parse');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
let parsed = 0;
for (const [, attrs, source] of scripts) {
  if (/\bsrc\s*=/.test(attrs) || !source.trim()) continue;
  try { new vm.Script(source, { filename: 'index.html inline script' }); parsed++; }
  catch (e) { bad('inline script syntax — ' + e.message.split('\n')[0]); }
}
parsed ? ok(parsed + ' inline script blocks parse') : bad('no inline scripts were parsed');

console.log('\n[7] required deliverables present');
for (const f of ['AUDIT_REPORT.md', 'AGENTS.md', 'docs/SAAS_READINESS_AUDIT.md', 'docs/AUTH_ARCHITECTURE.md',
  '.env.example', 'api/intake.js', 'api/public-form.js', 'supabase/migrations', 'tools/backup-supabase-records.js',
  'tools/restore-supabase-records.js', 'tools/security-test.js', 'tools/saas-foundation-test.js',
  'tools/identity-foundation-test.js', 'tools/tenant-foundation-test.js', 'supabase/functions/identity/index.ts']) {
  exists(f) ? ok(f) : bad('missing ' + f);
}

console.log(`\nResult: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
