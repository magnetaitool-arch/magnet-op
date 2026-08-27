#!/usr/bin/env node
'use strict';

// Offline behavior tests for public recruitment/sales intake. No network or
// messages are sent; fetch is replaced with a deterministic local stub.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const vercelIntake = require(path.join(ROOT, 'api/intake.js'));
const netlifyIntake = require(path.join(ROOT, 'netlify/functions/intake.js'));

let pass = 0;
let fail = 0;
const ok = (label) => { pass++; console.log('  ok   ' + label); };
const bad = (label) => { fail++; console.log('  FAIL ' + label); };
const check = (condition, label) => condition ? ok(label) : bad(label);
const same = (actual, expected, label) => actual === expected ? ok(label) : bad(`${label} (expected ${expected}, got ${actual})`);

const previous = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ORGANIZATION_SLUG: process.env.SUPABASE_ORGANIZATION_SLUG,
  MAGNET_FORM_ALLOWED_ORIGINS: process.env.MAGNET_FORM_ALLOWED_ORIGINS,
  PUBLIC_FORM_ALLOWED_ORIGINS: process.env.PUBLIC_FORM_ALLOWED_ORIGINS,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  SALES_EMAIL: process.env.SALES_EMAIL,
};
process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-service-key';
process.env.SUPABASE_ORGANIZATION_SLUG = 'magnet';
process.env.RESEND_API_KEY = 'offline-resend-key';
process.env.SALES_EMAIL = 'sales@example.invalid';
delete process.env.PUBLIC_FORM_ALLOWED_ORIGINS;
process.env.MAGNET_FORM_ALLOWED_ORIGINS = 'https://magnetofficial.com';

let calls = [];
let rpcError = '';
const oldFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).includes('/organizations?')) {
    return { ok: true, status: 200, json: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] };
  }
  if (String(url).includes('/rpc/submit_public_intake')) {
    if (rpcError) return { ok: false, status: 400, json: async () => ({ message: rpcError }) };
    const request = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, id: request.p_intake_kind === 'candidate' ? 'can-test' : 'lea-test', replayed: false, notificationsQueued: true }) };
  }
  if (String(url).includes('/outbox_messages?')) {
    return { ok: true, status: 200, json: async () => [] };
  }
  throw new Error('unexpected fetch');
};

function callVercel({ origin, body, headers = {}, method = 'POST' }) {
  const output = { headers: {}, statusCode: 0, body: '' };
  const reqHeaders = { ...headers };
  if (origin !== undefined) reqHeaders.origin = origin;
  const response = {
    setHeader(name, value) { output.headers[String(name).toLowerCase()] = value; },
    end(value) { output.body = value; },
    set statusCode(value) { output.statusCode = value; },
    get statusCode() { return output.statusCode; },
  };
  return vercelIntake({ method, headers: reqHeaders, body: body || {} }, response).then(() => output);
}

(async () => {
  console.log('[1] origin, validation, and bot guards');
  calls = [];
  const blocked = await callVercel({ origin: 'https://attacker.vercel.app', body: { type: 'lead', name: 'Blocked', email: 'blocked@example.com' } });
  same(blocked.statusCode, 403, 'rejects an untrusted public-form origin');
  same(calls.length, 0, 'untrusted origin never reaches Supabase');
  same(blocked.headers['access-control-allow-origin'], undefined, 'does not reflect an untrusted origin');

  const websitePreflight = await callVercel({ origin: 'https://magnetofficial.com', method: 'OPTIONS' });
  same(websitePreflight.statusCode, 200, 'allows the configured Magnet website origin');
  same(websitePreflight.headers['access-control-allow-origin'], 'https://magnetofficial.com', 'reflects only the configured website origin');

  const invalid = await callVercel({ origin: 'https://magnet-os-staging.vercel.app', body: { type: 'candidate', fullName: 'Missing contacts' } });
  same(invalid.statusCode, 400, 'rejects an incomplete candidate');
  same(calls.length, 0, 'invalid candidate never reaches Supabase');

  const bot = await callVercel({ origin: 'https://magnet-os-staging.vercel.app', body: { type: 'lead', hp: 'filled' } });
  same(bot.statusCode, 200, 'honeypot returns a non-revealing success');
  same(JSON.parse(bot.body).skipped, true, 'honeypot skips persistence');
  same(calls.length, 0, 'honeypot never reaches Supabase');

  console.log('\n[2] transactional service command');
  calls = [];
  const accepted = await callVercel({
    origin: 'https://magnet-os-staging.vercel.app',
    headers: { 'Idempotency-Key': 'website-form/submission-123', 'x-forwarded-for': '203.0.113.8', 'user-agent': 'Offline browser' },
    body: { type: 'lead', name: 'Valid Lead', company: 'Example', email: 'Lead@Example.com', phone: '+201001234567', role: 'owner', organization_id: 'attacker-org', message: 'Hello' },
  });
  same(accepted.statusCode, 200, 'valid lead is accepted');
  same(accepted.headers['access-control-allow-origin'], 'https://magnet-os-staging.vercel.app', 'returns exact-origin CORS');
  same(calls.length, 3, 'loads tenant, executes one database command, then checks its durable outbox');
  const rpcCall = calls.find((call) => call.url.includes('/rpc/submit_public_intake'));
  check(rpcCall && !calls.some((call) => call.url.includes('/rest/v1/records')), 'never writes records directly from the route');
  const rpcBody = JSON.parse(rpcCall.init.body);
  same(rpcBody.p_idempotency_key, 'website-form/submission-123', 'passes validated idempotency key');
  same(rpcBody.p_payload.email, 'lead@example.com', 'normalizes email server-side');
  same(rpcBody.p_payload.role, undefined, 'drops untrusted role claims');
  same(rpcBody.p_payload.organization_id, undefined, 'drops untrusted organization claims');
  check(/^[A-Za-z0-9_-]{43}$/.test(rpcBody.p_fingerprint_hash), 'sends only a one-way request fingerprint');

  console.log('\n[3] durable error semantics and Netlify parity');
  rpcError = 'rate_limited';
  const limited = await callVercel({ origin: 'https://magnet-os-staging.vercel.app', body: { type: 'lead', name: 'Rate Limited', email: 'rate@example.com' } });
  same(limited.statusCode, 429, 'maps database rate limit to HTTP 429');
  same(JSON.parse(limited.body).error, 'rate_limited', 'returns a stable retryable error category');
  rpcError = '';

  const netlify = await netlifyIntake.handler({
    httpMethod: 'POST',
    headers: { origin: 'https://magnet-os-staging.vercel.app', 'idempotency-key': 'netlify/submission-123' },
    body: JSON.stringify({ type: 'candidate', fullName: 'Valid Candidate', mobile: '+201001234567', email: 'candidate@example.com' }),
  });
  same(netlify.statusCode, 200, 'Netlify adapter uses the same secure intake path');
  same(JSON.parse(netlify.body).notificationsQueued, true, 'Netlify receives durable notification status');

  global.fetch = oldFetch;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  console.log(`\nResult: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  global.fetch = oldFetch;
  console.error(error);
  process.exit(1);
});
