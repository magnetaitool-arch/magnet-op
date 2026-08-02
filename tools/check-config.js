#!/usr/bin/env node
// Magnet OS — configuration & connectivity check. Read-only; safe to run anytime.
// Verifies env vars, pings Supabase, checks the accounts Edge Function, and warns
// if _accounts is still anon-readable (the password-hash exposure risk).
//
//   node tools/check-config.js        (or: npm run check:config)
'use strict';
const lib = require('./_lib');

(async () => {
  lib.loadDotEnv();
  const url = (process.env.SUPABASE_URL || lib.DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'sb_publishable_6Qe2KdPIZ13Ij2wvkS12rA_k2ytZQLz';
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  let warn = 0, fail = 0;
  const ok = (m) => console.log('  ok   ' + m);
  const w = (m) => { warn++; console.log('  warn ' + m); };
  const f = (m) => { fail++; console.log('  FAIL ' + m); };

  console.log('Magnet OS config check\nSUPABASE_URL = ' + url);

  console.log('\n[env]');
  process.env.SUPABASE_SERVICE_ROLE_KEY ? ok('SUPABASE_SERVICE_ROLE_KEY set') : w('SUPABASE_SERVICE_ROLE_KEY not set (backup of _accounts + restore need it)');
  process.env.RESEND_API_KEY ? ok('RESEND_API_KEY set') : w('RESEND_API_KEY not set (email + forgot-password disabled)');

  console.log('\n[supabase records table]');
  try {
    const r = await fetch(url + '/rest/v1/records?select=id&limit=1', { headers: lib.restHeaders(anon) });
    r.ok ? ok('records reachable with anon key (' + r.status + ')') : f('records read failed (' + r.status + ') — did you run supabase-schema.sql?');
  } catch (e) { f('records unreachable: ' + (e.message || e)); }

  console.log('\n[security: _accounts exposure]');
  try {
    const r = await fetch(url + '/rest/v1/records?select=id&coll=eq._accounts&limit=1', { headers: lib.restHeaders(anon) });
    if (r.status === 200) {
      const rows = await r.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) f('_accounts is ANON-READABLE — password hashes are exposed. Apply supabase/migrations/002_records_rls_hardening.sql NOW.');
      else ok('_accounts returns no rows to anon — RLS filtering is active.');
    } else if (r.status === 401 || r.status === 403) ok('_accounts blocked for anon (' + r.status + ') — lockdown is applied. Good.');
    else w('_accounts anon SELECT returned ' + r.status);
  } catch (e) { w('_accounts check errored: ' + (e.message || e)); }

  console.log('\n[accounts edge function]');
  try {
    const r = await fetch(url + '/functions/v1/accounts', { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', identifier: '__nobody__', password: '__x__' }) });
    if (r.status === 404) w('accounts function NOT deployed (404) — login falls back to legacy path. Deploy it: supabase functions deploy accounts --no-verify-jwt');
    else { const d = await r.json().catch(() => ({})); (d && d.ok === false) ? ok('accounts function deployed and responding') : ok('accounts function reachable (' + r.status + ')'); }
  } catch (e) { w('accounts function unreachable: ' + (e.message || e)); }

  console.log('\n[email endpoint]');
  try {
    // Browser traffic must carry an explicitly allowed Origin. An origin-less
    // request now correctly returns 403 unless it also carries the shared
    // server secret, so use the production origin for this payload check.
    const r = await fetch('https://magnet-op.vercel.app/api/send-email', {
      method: 'POST',
      headers: { Origin: 'https://magnet-op.vercel.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 400 (missing to/subject) means the function is live; 500 means key missing.
    if (r.status === 400) ok('/api/send-email live (validates input)');
    else if (r.status === 500) w('/api/send-email live but RESEND_API_KEY not set on host');
    else w('/api/send-email returned ' + r.status);
  } catch (e) { w('/api/send-email check errored: ' + (e.message || e)); }

  console.log('\n[email origin guard]');
  try {
    // This intentionally incomplete payload can never send an email. It only
    // verifies that an unrelated Vercel project cannot use the endpoint as a relay.
    const r = await fetch('https://magnet-op.vercel.app/api/send-email', {
      method: 'POST',
      headers: { Origin: 'https://untrusted-magnet-check.vercel.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.status === 403 && !r.headers.get('access-control-allow-origin')) ok('email endpoint rejects untrusted Vercel origins');
    else f('email endpoint accepts an untrusted Vercel origin — deploy the hardened api/send-email.js');
  } catch (e) { w('email origin-guard check errored: ' + (e.message || e)); }

  console.log(`\nResult: ${fail} fail, ${warn} warn.`);
  process.exit(fail ? 1 : 0);
})();
