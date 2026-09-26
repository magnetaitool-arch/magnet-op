'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8');
// Execute the real legacy handlers with isolated side-effect recorders.
// This catches false-success behavior; it does not pretend to exercise hosted APIs.
function automationHarness(db) {
  const events = [];
  const source = html.slice(
    html.indexOf('const runAutomation ='),
    html.indexOf('const toggleAutomation ='),
  );
  const context = {
    db,
    alert: (message) => events.push(['alert', message]),
    getLang: () => 'en',
    thisMonth: () => '2026-09',
    todayISO: () => '2026-09-25',
    nowISO: () => '2026-09-25T00:00:00Z',
    createRecord: (...args) => {
      events.push(['create', ...args]);
      return { id: 'synthetic' };
    },
    updateRecord: (...args) => events.push(['update', ...args]),
    addNotification: (...args) => events.push(['notification', ...args]),
    addActivity: (...args) => events.push(['activity', ...args]),
    showProPopup: (...args) => events.push(['success', ...args]),
    invTotal: (i) => Number(i.amount),
    invPaid: (i) => Number(i.paid || 0),
  };
  const run = vm.runInNewContext(source + '\nrunAutomation;', context);
  return { run, events };
}
test('unsupported automation definitions perform no writes or success notifications', () => {
  for (const id of [
    'auto-onboard',
    'auto-tasknotify',
    'auto-approval',
    'auto-proposal',
    'unknown',
  ]) {
    const { run, events } = automationHarness({});
    assert.equal(run({ id }).error, 'automation_unavailable');
    assert.deepEqual(
      events.map((e) => e[0]),
      ['alert'],
    );
  }
});
test('invoice reminder excludes paid, cancelled, draft, deleted and fully settled invoices', () => {
  const invoices = ['Paid', 'Cancelled', 'Invoice Draft', 'Sent'].map((status, n) => ({
    id: String(n),
    status,
    dueDate: '2026-09-01',
    amount: 100,
  }));
  invoices.push({
    id: 'partial',
    status: 'Partially Paid',
    dueDate: '2026-09-01',
    amount: 100,
    paid: 50,
  });
  invoices.push({ id: 'settled', status: 'Sent', dueDate: '2026-09-01', amount: 100, paid: 100 });
  invoices.push({ id: 'deleted', status: 'Sent', dueDate: '2026-09-01', amount: 100, _del: true });
  const { run, events } = automationHarness({ invoices });
  run({ id: 'auto-invoice', name: 'Invoice Reminder' });
  assert.deepEqual(
    events.filter((e) => e[0] === 'notification').map((e) => e.at(-1)),
    ['3', 'partial'],
  );
});
test('manual report states the actual data scope', () => {
  const { run, events } = automationHarness({ tasks: [], invoices: [], approvalRequests: [] });
  run({ id: 'auto-report' });
  const report = events.find((e) => e[0] === 'create' && e[1] === 'reports')[2];
  assert.match(report.notes, /not a period-filtered performance report/);
  assert.match(report.title, /Snapshot/);
});
function webhook(fetch, configured = true) {
  const start = html.indexOf('async function triggerWebhook(');
  const end = html.indexOf('/* ============================ AUTO-BACKUP', start);
  return vm.runInNewContext(html.slice(start, end) + '\ntriggerWebhook;', {
    store: {
      get: () =>
        JSON.stringify({ webhooks: configured ? { test: 'https://example.invalid/hook' } : {} }),
    },
    CFG_KEY: 'config',
    fetch,
    nowISO: () => '2026-09-25T00:00:00Z',
    AbortSignal,
  });
}
test('webhook success requires HTTP acceptance; rejected, missing and unknown delivery stay failures', async () => {
  assert.equal((await webhook(async () => ({ ok: true }))('test', {})).accepted, true);
  assert.equal((await webhook(async () => ({ ok: false }))('test', {})).error, 'delivery_rejected');
  assert.equal(
    (
      await webhook(async () => {
        throw new Error('timeout');
      })('test', {})
    ).error,
    'delivery_unconfirmed',
  );
  assert.equal(
    (
      await webhook(async () => {
        throw new Error('must not run');
      }, false)('test', {})
    ).error,
    'not_configured',
  );
});

function conversionHarness(response, failure, currentContext = true) {
  const calls = [];
  let cache = {
    clients: [{ id: 'existing' }],
    workflows: [],
    leads: [{ id: 'lead', status: 'Won' }],
  };
  const start = html.indexOf('const convertLead = async');
  const end = html.indexOf('const convertCandidate', start);
  const run = vm.runInNewContext(html.slice(start, end) + '\nconvertLead;', {
    organizationId: 'tenant',
    commitContextCurrent: () => currentContext,
    sbAccessToken: () => 'synthetic-token',
    cfg: { current: {} },
    workspaceRpc: async (_cfg, name, args) => {
      calls.push(['rpc', name, args]);
      if (failure) throw new Error(failure);
      return response;
    },
    setDb: (update) => {
      cache = update(cache);
      calls.push(['cache']);
    },
    refreshCanonicalNotifications: () => calls.push(['refresh']),
    showProPopup: () => calls.push(['success']),
    setRoute: (route) => calls.push(['route', route]),
    triggerWebhook: (type) => calls.push(['webhook', type]),
  });
  return { run, calls, cache: () => cache };
}
test('conversion UI does not save partial local records or announce success after RPC failure', async () => {
  const h = conversionHarness(null, 'lead_version_conflict');
  await assert.rejects(h.run({ id: 'lead' }, 3), /lead_version_conflict/);
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ['rpc'],
  );
  assert.deepEqual(h.cache().clients, [{ id: 'existing' }]);
});
test('conversion UI reflects persisted response once and preserves configured first-run integration hooks', async () => {
  const response = {
    ok: true,
    created: true,
    replayed: false,
    client: { id: 'client' },
    workflow: { id: 'workflow' },
    lead: { id: 'lead', convertedClientId: 'client' },
  };
  const h = conversionHarness(response);
  await h.run({ id: 'lead' }, 3);
  assert.equal(h.calls[0][1], 'convert_crm_lead_v2');
  assert.equal(h.calls[0][2].p_expected_version, 3);
  assert.equal(h.calls[0][2].p_organization_id, 'tenant');
  assert.equal(h.cache().leads[0].convertedClientId, 'client');
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'webhook').map((c) => c[1]),
    ['newClientWebhook', 'leadWonWebhook'],
  );
  response.replayed = true;
  const retry = conversionHarness(response);
  await retry.run({ id: 'lead' }, 3);
  assert.equal(
    retry.calls.some((c) => c[0] === 'webhook'),
    false,
  );
});

test('late conversion response cannot populate a different user or workspace cache', async () => {
  const h = conversionHarness(
    {
      ok: true,
      client: { id: 'foreign-client' },
      workflow: { id: 'foreign-workflow' },
      lead: { id: 'lead' },
    },
    null,
    false,
  );
  await assert.rejects(h.run({ id: 'lead' }, 1), /workspace_changed_reload_conversion/);
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ['rpc'],
  );
  assert.deepEqual(h.cache().clients, [{ id: 'existing' }]);
});

test('all directly rendered application icons exist, including report/brief printing', () => {
  const start = html.indexOf('const Icon = {');
  const end = html.indexOf('window.Icon = Icon;', start);
  const iconSource = html.slice(start, end);
  const icons = vm.runInNewContext(iconSource + '\nIcon;', { _I: () => () => null });
  for (const match of html.matchAll(/React\.createElement\((Icon\.\w+(?:\s*\|\|\s*Icon\.\w+)*)/g)) {
    const component = vm.runInNewContext(match[1], { Icon: icons });
    assert.equal(typeof component, 'function', `Missing renderable icon: ${match[1]}`);
  }
});
