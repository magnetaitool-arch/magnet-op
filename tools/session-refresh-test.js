'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionRefresh } = require('../modules/session-refresh');
const cfg = { url: 'https://test.supabase.co', key: 'public-test-key' };
const original = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 100 };
const rotated = { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 5000 };
function fixture(fetch) {
  let session = { ...original },
    time = 200000,
    writes = 0;
  const deps = {
    read: () => session,
    write: (value) => {
      session = value;
      writes++;
    },
    fetch,
    now: () => time,
  };
  return {
    deps,
    manager: createSessionRefresh(deps),
    read: () => session,
    writes: () => writes,
    set: (value) => {
      session = value;
    },
    advance: (ms) => {
      time += ms;
    },
  };
}
function reply(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('single flight rotates exactly once and stores provider expiry', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return pending.promise;
  });
  const first = f.manager.refresh(cfg),
    second = f.manager.refresh(cfg);
  assert.equal(first, second);
  pending.resolve(reply(rotated));
  assert.equal((await first).status, 'refreshed');
  assert.equal(calls, 1);
  assert.deepEqual(f.read(), rotated);
  assert.equal(f.writes(), 1);
});
test('network, rate limit, server, unknown auth and malformed responses preserve session with bounded backoff', async () => {
  for (const response of [
    () => {
      throw Error('offline');
    },
    () => reply({}, 429, { 'retry-after': '60' }),
    () => reply({}, 503),
    () => reply({ code: 'bad_jwt' }, 401),
    () => reply({ code: 'refresh_token_already_used' }, 400),
    () => reply({}),
    () => reply({ ...rotated, expires_at: 100 }),
  ]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return response();
    });
    const result = await f.manager.refresh(cfg);
    assert.equal(result.status, 'retry');
    assert.ok(result.retryAt >= 205000);
    assert.deepEqual(f.read(), original);
    assert.equal(f.writes(), 0);
    await f.manager.refresh(cfg);
    assert.equal(calls, 1);
    f.advance(3600001);
    await f.manager.refresh(cfg);
    assert.equal(calls, 2);
  }
});
test('only explicit terminal provider codes clear the current session', async () => {
  for (const code of [
    'refresh_token_not_found',
    'session_not_found',
    'session_expired',
    'user_banned',
  ]) {
    const f = fixture(async () => reply({ code }, 400));
    assert.deepEqual(await f.manager.refresh(cfg), { status: 'invalid', invalid: true });
    assert.equal(f.read(), null);
  }
  const f = fixture(async () => reply({ code: 'session_expired' }, 503));
  assert.equal((await f.manager.refresh(cfg)).status, 'retry');
  assert.deepEqual(f.read(), original);
});
test('late success cannot resurrect logout or overwrite another login', async () => {
  for (const replacement of [null, { ...rotated, access_token: 'other-account' }]) {
    const pending = deferred();
    const f = fixture(async () => pending.promise);
    const request = f.manager.refresh(cfg);
    f.set(replacement);
    pending.resolve(reply(rotated));
    await request;
    assert.deepEqual(f.read(), replacement);
    assert.equal(f.writes(), 0);
  }
});
test('late provider rejection cannot erase a newer session', async () => {
  const pending = deferred();
  const f = fixture(async () => pending.promise);
  const request = f.manager.refresh(cfg);
  f.set(rotated);
  pending.resolve(reply({ code: 'session_expired' }, 400));
  assert.equal((await request).status, 'superseded');
  assert.deepEqual(f.read(), rotated);
  assert.equal(f.writes(), 0);
});
test('two tabs sharing a Web Lock reread rotated storage before fetching', async () => {
  const pending = deferred();
  let calls = 0,
    queue = Promise.resolve();
  const f = fixture(async () => {
    calls++;
    return pending.promise;
  });
  const lock = (_name, run) => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  const a = createSessionRefresh({ ...f.deps, lock }),
    b = createSessionRefresh({ ...f.deps, lock });
  const first = a.refresh(cfg),
    second = b.refresh(cfg);
  pending.resolve(reply(rotated));
  assert.equal((await first).status, 'refreshed');
  assert.equal((await second).status, 'superseded');
  assert.equal(calls, 1);
});
test('retry recovers without signing in; a different session does not inherit backoff', async () => {
  let calls = 0;
  const f = fixture(async () => (++calls === 1 ? reply({}, 503) : reply(rotated)));
  await f.manager.refresh(cfg);
  f.advance(5001);
  assert.equal((await f.manager.refresh(cfg)).status, 'refreshed');
  assert.equal(f.manager.retryAt(cfg.url), 0);
  const g = fixture(async () => reply({}, 503));
  await g.manager.refresh(cfg);
  g.set(rotated);
  assert.equal(g.manager.retryAt(cfg.url), 0);
});
test('expiry derives from expires_in; request times out and contains only refresh credentials', async () => {
  const f = fixture(async (_url, options) => {
    assert.ok(options.signal);
    assert.equal(options.headers.apikey, cfg.key);
    assert.deepEqual(JSON.parse(options.body), { refresh_token: original.refresh_token });
    return reply({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  });
  assert.equal((await f.manager.refresh(cfg)).session.expires_at, 3800);
});
