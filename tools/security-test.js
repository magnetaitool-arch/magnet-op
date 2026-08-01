#!/usr/bin/env node
// Focused, offline behavior checks for the two email endpoints. No messages are
// sent: global fetch is replaced with a local stub before either handler runs.
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const vercelEmail = require(path.join(ROOT, 'api/send-email.js'));
const netlifyEmail = require(path.join(ROOT, 'netlify/functions/send-email.js'));

let pass = 0;
let fail = 0;
const ok = (message) => { pass++; console.log('  ok   ' + message); };
const bad = (message) => { fail++; console.log('  FAIL ' + message); };
const same = (actual, expected, message) => actual === expected ? ok(message) : bad(message + ` (expected ${expected}, got ${actual})`);

let fetchCalls = 0;
const oldFetch = global.fetch;
global.fetch = async () => {
  fetchCalls++;
  return { ok: true, status: 200, json: async () => ({ id: 'test-email-id' }) };
};

process.env.RESEND_API_KEY = 'test-key';
process.env.FROM_EMAIL = 'Magnet OS <onboarding@resend.dev>';
delete process.env.VERCEL_URL;
delete process.env.EMAIL_ALLOWED_ORIGINS;
delete process.env.EMAIL_SHARED_SECRET;

function emailBody() {
  return { to: 'person@example.com', subject: 'Test message', text: 'This is an offline test.' };
}

async function callVercel({ origin, method = 'POST', body = emailBody(), secret }) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (secret !== undefined) headers['x-magnet-secret'] = secret;
  const out = { headers: {}, statusCode: 0, body: '' };
  const res = {
    setHeader(name, value) { out.headers[String(name).toLowerCase()] = value; },
    end(value) { out.body = value; },
    set statusCode(value) { out.statusCode = value; },
    get statusCode() { return out.statusCode; },
  };
  await vercelEmail({ method, headers, body }, res);
  return out;
}

async function callNetlify({ origin, method = 'POST', body = emailBody(), secret }) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (secret !== undefined) headers['x-magnet-secret'] = secret;
  return await netlifyEmail.handler({ httpMethod: method, headers, body: JSON.stringify(body) });
}

(async () => {
  console.log('[1] Vercel email origin and payload guard');
  fetchCalls = 0;
  const blockedVercel = await callVercel({ origin: 'https://attacker.vercel.app' });
  same(blockedVercel.statusCode, 403, 'rejects unrelated Vercel subdomains');
  same(fetchCalls, 0, 'does not call Resend for a rejected origin');
  same(blockedVercel.headers['access-control-allow-origin'], undefined, 'does not reflect a rejected origin');

  const missingOrigin = await callVercel({});
  same(missingOrigin.statusCode, 403, 'requires a secret for origin-less server traffic');

  const allowedVercel = await callVercel({ origin: 'https://magnet-op.vercel.app' });
  same(allowedVercel.statusCode, 200, 'allows the exact production origin');
  same(allowedVercel.headers['access-control-allow-origin'], 'https://magnet-op.vercel.app', 'returns exact-origin CORS');
  same(fetchCalls, 1, 'calls Resend once for a permitted email');

  const invalidPayload = await callVercel({ origin: 'https://magnet-op.vercel.app', body: { to: 'person@example.com', subject: 'bad\nsubject', text: 'x' } });
  same(invalidPayload.statusCode, 400, 'rejects header-injection payloads');
  same(fetchCalls, 1, 'does not call Resend for an invalid payload');

  process.env.EMAIL_SHARED_SECRET = 'test-shared-secret';
  const trustedServer = await callVercel({ secret: 'test-shared-secret' });
  same(trustedServer.statusCode, 200, 'allows trusted origin-less server traffic');
  same(fetchCalls, 2, 'calls Resend for trusted server traffic');

  console.log('\n[2] Netlify legacy email guard');
  fetchCalls = 0;
  const blockedNetlify = await callNetlify({ origin: 'https://attacker.vercel.app' });
  same(blockedNetlify.statusCode, 403, 'Netlify also rejects unrelated Vercel subdomains');
  same(fetchCalls, 0, 'Netlify does not call Resend for a rejected origin');

  const allowedNetlify = await callNetlify({ origin: 'https://magnet-op.vercel.app' });
  same(allowedNetlify.statusCode, 200, 'Netlify allows the exact production origin');
  same(fetchCalls, 1, 'Netlify calls Resend once for a permitted email');

  const trustedNetlify = await callNetlify({ secret: 'test-shared-secret' });
  same(trustedNetlify.statusCode, 200, 'Netlify allows trusted origin-less server traffic');
  same(fetchCalls, 2, 'Netlify calls Resend for trusted server traffic');

  global.fetch = oldFetch;
  console.log(`\nResult: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  global.fetch = oldFetch;
  console.error(error);
  process.exit(1);
});
