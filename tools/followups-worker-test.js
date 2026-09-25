'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleOutbox } = require('../server/outbox');
const env = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key',
  OUTBOX_WORKER_SECRET: 'synthetic-worker-secret',
  CRM_FOLLOWUP_REMINDERS_ENABLED: 'true',
};
test('follow-up reminders run only on authenticated worker drain and failures remain visible', async () => {
  const previous = global.fetch;
  let fail = false;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('enqueue_due_crm_followups_v2'))
      return new Response(JSON.stringify(fail ? { error: 'unavailable' } : 2), {
        status: fail ? 503 : 200,
      });
    if (url.endsWith('claim_outbox_messages')) return new Response('[]');
    throw Error('unexpected-provider-call');
  };
  try {
    const denied = await handleOutbox(
      { method: 'POST', headers: {}, body: { action: 'drain' } },
      env,
    );
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 0);
    const request = {
      method: 'POST',
      headers: { 'x-outbox-secret': env.OUTBOX_WORKER_SECRET },
      body: { action: 'drain' },
    };
    const success = await handleOutbox(request, env);
    assert.equal(success.status, 200);
    assert.deepEqual(success.body.reminders, { status: 'READY', created: 2 });
    fail = true;
    const failure = await handleOutbox(request, env);
    assert.equal(failure.status, 503);
    assert.equal(failure.body.ok, false);
    assert.equal(failure.body.reminders.status, 'FAILED');
    calls.length = 0;
    const disabled = await handleOutbox(request, {
      ...env,
      CRM_FOLLOWUP_REMINDERS_ENABLED: 'false',
    });
    assert.equal(disabled.body.reminders.status, 'DISABLED');
    assert.ok(calls.every((url) => !url.endsWith('enqueue_due_crm_followups_v2')));
  } finally {
    global.fetch = previous;
  }
});
