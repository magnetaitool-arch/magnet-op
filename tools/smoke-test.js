#!/usr/bin/env node
// Magnet OS — offline smoke test. No network, no secrets. Verifies the codebase
// has no syntax errors and none of the known dangerous patterns regressed.
//
//   node tools/smoke-test.js        (or: npm run smoke)
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./_lib');
const ROOT = lib.REPO_ROOT;

let fail = 0, pass = 0;
const ok = (m) => { pass++; console.log('  ok   ' + m); };
const bad = (m) => { fail++; console.log('  FAIL ' + m); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

console.log('[1] node --check on server JS');
for (const file of ['api/send-email.js', 'api/intake.js', 'netlify/functions/intake.js', 'netlify/functions/send-email.js',
  'serviceworker.js', 'tools/_lib.js', 'tools/backup-supabase-records.js', 'tools/backup-local-data.js',
  'tools/validate-backup.js', 'tools/restore-supabase-records.js', 'tools/check-config.js']) {
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

console.log('\n[4] frontend password-change hardening');
const html = read('index.html');
/changepw'?,\s*\{\s*token:getAcctToken\(\),\s*currentPassword:cur,\s*newPassword:np/.test(html.replace(/\s+/g, ' '))
  ? ok('PwResetForm sends newPassword (not a client hash)')
  : (/newHash\s*=\s*await\s+AUTH\.hashPassword/.test(html) ? bad('PwResetForm still computes/sends newHash') : ok('no client-side newHash in change-password'));

console.log('\n[5] dangerous-pattern scan');
// admin123 legitimately appears as the ensureDefaultOwner seed + a comment. Only
// a hardcoded LOGIN COMPARISON (e.g. password==='admin123') is a real bypass.
const bypass = /(===?\s*['"]admin123['"])|(['"]admin123['"]\s*===?)|password\s*==?=?\s*['"]admin123['"]/.test(html);
const seedOnly = /hashPassword\('admin123'\)/.test(html);
bypass ? bad('admin123 used in a hardcoded login comparison (bypass risk)')
       : ok(`admin123 present only as ${seedOnly ? 'ensureDefaultOwner seed' : 'text'} (no login bypass)`);
/sb_secret_|service_role.{0,40}=\s*['"]eyJ/.test(html) ? bad('possible service_role/secret key in index.html') : ok('no service_role/secret key in index.html');
/\/\.netlify\/functions\/intake/.test(html) ? bad('index.html calls netlify intake (Vercel default) — use /api/intake') : ok('no hardcoded netlify intake call in index.html');

console.log('\n[6] required deliverables present');
for (const f of ['AUDIT_REPORT.md', '.env.example', 'api/intake.js', 'supabase/migrations',
  'tools/backup-supabase-records.js', 'tools/restore-supabase-records.js']) {
  exists(f) ? ok(f) : bad('missing ' + f);
}

console.log(`\nResult: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
