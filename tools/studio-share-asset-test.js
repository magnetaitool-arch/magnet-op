'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/studio-share-asset');
const response = () => ({
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
  },
  end(v) {
    this.body = JSON.parse(v);
  },
});
test('share asset rejects malformed requests without reaching privileged storage', async () => {
  const saved = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    throw Error('unexpected');
  };
  try {
    for (const req of [
      { method: 'GET' },
      { method: 'POST', body: {} },
      { method: 'POST', body: 'broken' },
    ]) {
      const res = response();
      await handler(req, res);
      assert.ok([403, 405].includes(res.statusCode));
      assert.equal(res.headers['Cache-Control'], 'private, no-store');
    }
    assert.equal(calls, 0);
  } finally {
    global.fetch = saved;
  }
});
test('share asset signs only the exact server-authorized path and refuses denied tokens', async () => {
  const saved = global.fetch,
    url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-key';
  const req = {
    method: 'POST',
    body: { token: 'a'.repeat(64), fileId: '12345678-1234-1234-1234-123456789012' },
  };
  try {
    let calls = [];
    global.fetch = async (u, opts) => {
      calls.push({ u, opts });
      return calls.length === 1
        ? {
            ok: true,
            json: async () => ({ bucket: 'private', path: 'tenant/image one.png', expiresIn: 30 }),
          }
        : {
            ok: true,
            json: async () => ({
              signedURL: '/object/sign/private/tenant/image%20one.png?token=test',
            }),
          };
    };
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].opts.body).expiresIn, 30);
    assert.match(calls[1].u, /private\/tenant\/image%20one\.png$/);
    assert.equal(Object.keys(res.body).join(','), 'url');
    assert.ok(!JSON.stringify(res.body).includes('server-only'));
    calls = [];
    global.fetch = async () => {
      calls.push(1);
      return { ok: false };
    };
    const denied = response();
    await handler(req, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = saved;
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }
});

test('private video preview CSP permits only the configured Supabase projects', () => {
  const config = require('../vercel.json');
  const policy = config.headers
    .find((g) => g.source === '/(.*)')
    .headers.find((h) => h.key === 'Content-Security-Policy').value;
  const media = policy
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('media-src '));
  assert.equal(
    media,
    "media-src 'self' https://xqqgbvigfojfydzfguan.supabase.co https://vsurqqbxjvqzvqbmetjw.supabase.co",
  );
});
