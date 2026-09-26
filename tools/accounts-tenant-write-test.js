'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { transpileModule, ScriptTarget } = require('typescript');
const source = fs.readFileSync('supabase/functions/accounts/index.ts', 'utf8');
const code = transpileModule(
  source.slice(
    source.indexOf('async function dbUpsert('),
    source.indexOf('async function dbDelete('),
  ),
  { compilerOptions: { target: ScriptTarget.ES2022 } },
).outputText;
function harness(existing, lookupOk = true) {
  let written,
    defaults = 0;
  const fetch = async (_url, options = {}) => {
    if (options.method === 'POST') {
      written = JSON.parse(options.body);
      return { ok: true };
    }
    return { ok: lookupOk, json: async () => existing };
  };
  const write = new Function(
    'fetch',
    'REST',
    'KEY',
    'legacyOrganizationId',
    code + ';return dbUpsert;',
  )(fetch, 'https://example.invalid/rest/v1/records', 'synthetic-key', async () => {
    defaults++;
    return 'legacy-org';
  });
  return { write, result: () => written, defaults: () => defaults };
}
test('account update preserves persisted tenant despite supplied tenant/default', async () => {
  const h = harness([{ organization_id: 'other-org' }]);
  await h.write([
    { id: 'synthetic-account', organization_id: 'forged-org', data: { lastLogin: 'test' } },
  ]);
  assert.equal(h.result()[0].organization_id, 'other-org');
  assert.equal(h.defaults(), 0);
});
test('only new legacy rows use trusted agency default', async () => {
  const h = harness([]);
  await h.write([{ id: 'new-account', organization_id: 'forged-org' }]);
  assert.equal(h.result()[0].organization_id, 'legacy-org');
  assert.equal(h.defaults(), 1);
});
test('missing existing ownership or failed lookup cannot silently reassign account', async () => {
  for (const h of [harness([{ organization_id: null }]), harness([], false), harness({})]) {
    await assert.rejects(h.write([{ id: 'existing-account' }]));
    assert.equal(h.result(), undefined);
  }
});
