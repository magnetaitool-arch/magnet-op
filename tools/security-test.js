#!/usr/bin/env node
'use strict';

// Offline security/reliability tests for the JWT-authorized delivery outbox.
// Provider and Supabase requests are stubbed; no network or email is sent.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const vercelEmail = require(path.join(ROOT, 'api/send-email.js'));
const netlifyEmail = require(path.join(ROOT, 'netlify/functions/send-email.js'));

let pass = 0;
let fail = 0;
const ok = (label) => { pass++; console.log('  ok   ' + label); };
const bad = (label) => { fail++; console.log('  FAIL ' + label); };
const same = (actual, expected, label) => actual === expected ? ok(label) : bad(`${label} (expected ${expected}, got ${actual})`);
const check = (condition, label) => condition ? ok(label) : bad(label);

const messageId = '11111111-1111-4111-8111-111111111111';
const correlationId = '22222222-2222-4222-8222-222222222222';
const oldFetch = global.fetch;
let providerCalls = 0;
let rpcCalls = [];
let claimEnabled = true;

global.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.includes('/rest/v1/rpc/')) {
    const name = target.split('/').pop();
    const body = JSON.parse(init.body || '{}');
    rpcCalls.push({ name, body, authorization: init.headers && init.headers.Authorization });
    if (name === 'current_identity_context') return { ok: true, status: 200, json: async () => ({ ok: true, roleKey: 'owner' }) };
    if (name === 'enqueue_email_message') return { ok: true, status: 200, json: async () => ({ ok: true, id: messageId, status: 'PENDING', correlationId }) };
    if (name === 'claim_outbox_messages') return { ok: true, status: 200, json: async () => claimEnabled ? [{
      id: messageId, organization_id: '33333333-3333-4333-8333-333333333333', kind: 'EMAIL_INTERNAL', recipient_ref: 'DIRECT_EMAIL',
      payload: { purpose: 'SYSTEM_TEST', to: ['person@example.com'], subject: 'Test message', text: 'Offline body' },
      idempotency_key: 'email/test-message', status: 'PROCESSING', attempt_count: 1, max_attempts: 5,
    }] : [] };
    if (name === 'finish_outbox_message') return { ok: true, status: 200, json: async () => ({ ok: true, id: messageId, status: body.p_outcome, correlationId }) };
    if (name === 'get_outbox_delivery_status') return { ok: true, status: 200, json: async () => ({ ok: true, id: messageId, status: 'DELIVERED', attemptCount: 1, correlationId }) };
    if (name === 'retry_outbox_message') return { ok: true, status: 200, json: async () => ({ ok: true, id: messageId, status: 'PENDING' }) };
  }
  if (target === 'https://api.resend.com/emails') {
    providerCalls++;
    return { ok: true, status: 200, json: async () => ({ id: 'provider-message-id' }) };
  }
  throw new Error('Unexpected offline fetch: ' + target);
};

process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-service-key';
process.env.RESEND_API_KEY = 'offline-resend-key';
process.env.FROM_EMAIL = 'Magnet OS <onboarding@resend.dev>';
process.env.OUTBOX_WORKER_SECRET = 'offline-worker-secret';
delete process.env.EMAIL_ALLOWED_ORIGINS;
delete process.env.VERCEL_URL;

function emailBody() {
  return { organizationId: '33333333-3333-4333-8333-333333333333', purpose: 'SYSTEM_TEST', to: 'person@example.com', subject: 'Test message', text: 'This is an offline test.', idempotencyKey: 'email/test-message' };
}

async function callVercel({ origin, method = 'POST', body = emailBody(), token, query, headers = {} }) {
  const reqHeaders = { ...headers };
  if (origin !== undefined) reqHeaders.origin = origin;
  if (token) reqHeaders.authorization = 'Bearer ' + token;
  const output = { headers: {}, statusCode: 0, body: '' };
  const response = {
    setHeader(name, value) { output.headers[String(name).toLowerCase()] = value; },
    end(value) { output.body = value; },
    set statusCode(value) { output.statusCode = value; },
    get statusCode() { return output.statusCode; },
  };
  await vercelEmail({ method, headers: reqHeaders, body, query: query || {} }, response);
  return output;
}

(async () => {
  console.log('[1] authorization and origin boundary');
  providerCalls = 0; rpcCalls = [];
  const blocked = await callVercel({ origin: 'https://attacker.vercel.app', token: 'user-jwt' });
  same(blocked.statusCode, 403, 'rejects unrelated Vercel origins');
  same(blocked.headers['access-control-allow-origin'], undefined, 'does not reflect a rejected origin');
  same(rpcCalls.length, 0, 'rejected origin cannot reach the database');

  const noSession = await callVercel({ origin: 'https://magnet-op.vercel.app' });
  same(noSession.statusCode, 401, 'requires a Supabase session for browser email');
  same(providerCalls, 0, 'missing session never reaches the provider');

  console.log('\n[2] durable enqueue and provider delivery');
  const sent = await callVercel({ origin: 'https://magnet-op.vercel.app', token: 'user-jwt' });
  same(sent.statusCode, 200, 'authorized email is delivered');
  const sentBody = JSON.parse(sent.body);
  same(sentBody.id, messageId, 'returns the durable outbox id');
  same(sentBody.status, 'Accepted', 'distinguishes provider acceptance from final delivery');
  same(providerCalls, 1, 'calls the provider only after durable enqueue');
  const enqueue = rpcCalls.find((call) => call.name === 'enqueue_email_message');
  check(enqueue && enqueue.authorization === 'Bearer user-jwt', 'database authorization uses the user JWT');
  same(enqueue.body.p_purpose, 'SYSTEM_TEST', 'passes an explicit capability-scoped purpose');
  same(enqueue.body.p_organization_id, '33333333-3333-4333-8333-333333333333', 'passes the explicitly selected tenant');
  check(/^[A-Za-z0-9_-]{43}$/.test(enqueue.body.p_request_hash), 'sends a stable one-way request hash');
  check(rpcCalls.some((call) => call.name === 'finish_outbox_message' && call.body.p_outcome === 'ACCEPTED'), 'records provider acceptance through the leased outbox command');

  console.log('\n[3] status, health, retries, and configuration failure');
  const status = await callVercel({ origin: 'https://magnet-op.vercel.app', method: 'GET', token: 'user-jwt', query: { id: messageId } });
  same(status.statusCode, 200, 'authorized user can query delivery state');
  same(JSON.parse(status.body).status, 'Delivered', 'maps database state for the UI');
  const health = await callVercel({ origin: 'https://magnet-op.vercel.app', method: 'GET', token: 'user-jwt', query: {} });
  same(health.statusCode, 200, 'health requires and accepts a valid identity context');
  same(JSON.parse(health.body).emailConfigured, true, 'health reports provider configuration without exposing values');

  delete process.env.RESEND_API_KEY;
  const notConfigured = await callVercel({ origin: 'https://magnet-op.vercel.app', token: 'user-jwt', body: { ...emailBody(), idempotencyKey: 'email/not-configured' } });
  same(notConfigured.statusCode, 202, 'configuration failure preserves the queued request');
  same(JSON.parse(notConfigured.body).status, 'Failed', 'configuration failure is visible instead of swallowed');
  check(rpcCalls.some((call) => call.name === 'finish_outbox_message' && call.body.p_error_category === 'CONFIGURATION_MISSING'), 'records a safe failure category');
  process.env.RESEND_API_KEY = 'offline-resend-key';

  console.log('\n[4] worker and Netlify compatibility');
  claimEnabled = false;
  const deniedWorker = await callVercel({ method: 'POST', body: { action: 'drain' } });
  same(deniedWorker.statusCode, 401, 'worker drain requires a server secret');
  const worker = await callVercel({ method: 'POST', body: { action: 'drain' }, headers: { 'x-outbox-secret': 'offline-worker-secret' } });
  same(worker.statusCode, 200, 'trusted worker can drain pending delivery');
  same(JSON.parse(worker.body).processed, 0, 'empty queue drains safely');

  claimEnabled = true;
  const netlify = await netlifyEmail.handler({
    httpMethod: 'POST', headers: { origin: 'https://magnet-op.vercel.app', authorization: 'Bearer user-jwt' },
    body: JSON.stringify(emailBody()), queryStringParameters: {},
  });
  same(netlify.statusCode, 200, 'Netlify compatibility route shares the same secure outbox');
  same(JSON.parse(netlify.body).status, 'Accepted', 'Netlify returns the same delivery state');

  global.fetch = oldFetch;
  console.log(`\nResult: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  global.fetch = oldFetch;
  console.error(error);
  process.exit(1);
});
