'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { resolveAuthEntry } = require('../modules/auth-entry');
const { publicRuntimeConfig } = require('../server/runtime-config');
const { createPreviewServer } = require('./dev-server');
const { STATIC_FILES, SERVER_FILES, staticPath } = require('./static-files');
const { build } = require('./build-static');
const ref = 'abcdefghijklmnopqrst';
const env = {
  SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_ANON_KEY: 'sb_publishable_test_only_public_value',
};
/** @param {Record<string, unknown>} changes @param {string} alg */
function jwt(changes = {}, alg = 'HS256') {
  const part = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return (
    part({ alg, typ: 'JWT' }) +
    '.' +
    part({ iss: 'supabase', ref, role: 'anon', exp: Date.now() / 1000 + 3600, ...changes }) +
    '.testsignature'
  );
}

test('runtime configuration accepts only public credential types without a project fallback', () => {
  assert.equal(publicRuntimeConfig({}), null);
  assert.deepEqual(publicRuntimeConfig(env), { url: env.SUPABASE_URL, key: env.SUPABASE_ANON_KEY });
  assert.ok(publicRuntimeConfig({ ...env, SUPABASE_ANON_KEY: jwt() }));
  for (const key of [
    'sb_secret_private_value',
    'eyJfake',
    jwt({ role: 'service_role' }),
    jwt({ role: 'authenticated' }),
    jwt({ ref: 'wrong' }),
    jwt({ exp: 1 }),
    jwt({}, 'none'),
  ]) {
    assert.equal(publicRuntimeConfig({ ...env, SUPABASE_ANON_KEY: key }), null);
  }
  assert.equal(publicRuntimeConfig({ ...env, SUPABASE_URL: 'https://evil.example' }), null);
  assert.equal(
    publicRuntimeConfig({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role' }),
    }),
    null,
  );
});

test('hosted startup never infers owner setup from missing config, failed discovery or cached accounts', () => {
  const base = {
    hosted: true,
    configured: true,
    status: null,
    hasSession: false,
    localAccountCount: 0,
  };
  assert.equal(resolveAuthEntry({ ...base, configured: false }), 'configuration-unavailable');
  assert.equal(resolveAuthEntry(base), 'service-unavailable');
  assert.equal(resolveAuthEntry({ ...base, hasSession: true }), 'service-unavailable');
  assert.equal(resolveAuthEntry({ ...base, localAccountCount: 5 }), 'service-unavailable');
  assert.equal(
    resolveAuthEntry({ ...base, status: { needsSetup: 'true' } }),
    'service-unavailable',
  );
  assert.equal(resolveAuthEntry({ ...base, status: { needsSetup: false } }), 'signin');
  assert.equal(resolveAuthEntry({ ...base, status: { needsSetup: true } }), 'setup');
  assert.equal(
    resolveAuthEntry({ ...base, status: { needsSetup: false }, hasSession: true }),
    'resume',
  );
});

test('explicit file development remains separate from hosted startup', () => {
  const base = {
    hosted: false,
    configured: false,
    status: null,
    hasSession: false,
    localAccountCount: 0,
  };
  assert.equal(resolveAuthEntry(base), 'setup');
  assert.equal(resolveAuthEntry({ ...base, localAccountCount: 1 }), 'signin');
  assert.equal(resolveAuthEntry({ ...base, hasSession: true }), 'resume');
});

test('browser module exposes the same decision function without Node globals', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../modules/auth-entry.js'), 'utf8'),
    sandbox,
  );
  assert.equal(
    vm.runInContext('MagnetAuthEntry.resolveAuthEntry({hosted:true,configured:false})', sandbox),
    'configuration-unavailable',
  );
  const app = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(app.indexOf('/modules/auth-entry.js') < app.indexOf('function App()'));
  assert.match(app, /window\.MagnetAuthEntry\.resolveAuthEntry/);
  assert.match(app, /function AuthEntryScreen/);
});

test('preview path allowlist blocks private files, encoded paths and APIs', () => {
  for (const file of [
    '/.env',
    '/.git/config',
    '/server/runtime-config.js',
    '/tools/dev-server.js',
    '/docs/ARCHITECTURE.md',
    '/%2eenv',
    '/%2e%2e/package.json',
    '/node_modules/x.js',
    '/api/intake',
    '/magnet-studio/.env',
    '/magnet-studio/design-qa.md',
    '/magnet-studio/vercel.json',
  ])
    assert.equal(staticPath(file), null, file);
  assert.equal(staticPath('/workspace'), 'index.html');
  for (const file of STATIC_FILES) assert.equal(staticPath('/' + file), file);
});

test('HTTP preview serves UI/ranges, refuses business writes and does not expose workspace source', async () => {
  const server = createPreviewServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Magnet OS/);
    const css = await fetch(base + '/styles/foundation.css');
    assert.match(css.headers.get('content-type') || '', /text\/css/);
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/server/runtime-config.js')).status, 404);
    assert.equal((await fetch(base + '/api/intake', { method: 'POST', body: '{}' })).status, 503);
    const config = await fetch(base + '/api/runtime-config');
    assert.equal(config.status, 503);
    assert.match(await config.text(), /=null/);
    const range = await fetch(base + '/magnet-login.mp4', { headers: { Range: 'bytes=0-99' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
    assert.equal(
      (await fetch(base + '/magnet-login.mp4', { headers: { Range: 'bytes=100-20' } })).status,
      416,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('production artifact has deterministic hashes and excludes secrets and unrelated projects', () => {
  const first = build(),
    second = build();
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((f) => f.path),
    [...STATIC_FILES, ...SERVER_FILES, 'vercel.json'],
  );
  for (const file of first) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(file.bytes > 0);
  }
  for (const file of [
    '.env',
    '.git',
    'backups',
    'magnet-studio/vercel.json',
    'magnet-studio/design-qa.md',
    'tools',
    'docs',
  ])
    assert.ok(!fs.existsSync(path.join(__dirname, '../.magnet-build', file)));
});
