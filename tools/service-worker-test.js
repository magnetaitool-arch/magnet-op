#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../serviceworker.js'), 'utf8');
const origin = 'https://magnet.example';
function harness({ failStorage = false, delayWrite } = {}) {
  const listeners = {}, stores = new Map(), deleted = [], calls = [];
  let network = async () => new Response('fresh', { headers: { 'Content-Type': 'text/html' } });
  const keyOf = key => new URL(typeof key === 'string' ? key : key.url, origin).href;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(key) { deleted.push(key); return stores.delete(key); },
    async open(name) {
      if (failStorage) throw new Error('Storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(key) { return store.get(keyOf(key))?.clone(); },
        async put(key, response) {
          if (delayWrite) await delayWrite;
          store.set(keyOf(key), new Response(await response.text(), { status: response.status, headers: response.headers }));
        }
      };
    }
  };
  vm.runInNewContext(source, { URL, Response, caches,
    fetch: req => { calls.push(req.url); return network(req); },
    self: { location: { origin }, clients: { claim: async () => {} }, skipWaiting: async () => {},
      addEventListener: (name, handler) => { listeners[name] = handler; } }
  });
  const current = source.match(/const CACHE = '([^']+)'/)[1];
  function dispatch(path, { navigation = true, headers = {}, method = 'GET' } = {}) {
    const waits = []; let response;
    listeners.fetch({ request: { url: new URL(path, origin).href, method, mode: navigation ? 'navigate' : 'cors', headers: new Headers(headers) },
      respondWith: value => { response = Promise.resolve(value); }, waitUntil: value => waits.push(value) });
    return { response, done: () => Promise.all(waits), waits };
  }
  return { dispatch, stores, deleted, calls, caches, current, listeners,
    setNetwork(fn) { network = fn; },
    offline() { network = async () => { throw new Error('Offline'); }; }
  };
}

test('root visit caches a canonical shell for unseen query links without retaining tokens', async () => {
  const h = harness();
  const first = h.dispatch('/?contractReview=test-only-token');
  assert.equal(await (await first.response).text(), 'fresh'); await first.done();
  assert.deepEqual([...h.stores.get(h.current).keys()], [origin + '/index.html']);
  h.offline();
  assert.equal(await (await h.dispatch('/?open=tasks&id=other').response).text(), 'fresh');
  assert.equal(await (await h.dispatch('/workspace').response).text(), 'fresh');
});

test('cache writes remain alive after the browser consumes the network response', async () => {
  let release; const delayWrite = new Promise(resolve => { release = resolve; });
  const h = harness({ delayWrite }); const event = h.dispatch('/');
  assert.equal(await (await event.response).text(), 'fresh');
  assert.equal(event.waits.length, 1);
  assert.equal(h.stores.get(h.current).size, 0);
  release(); await event.done();
  assert.equal(await (await h.caches.open(h.current)).match('/index.html').then(r => r.text()), 'fresh');
});

test('cold offline navigation returns a bilingual retry page and a real Response', async () => {
  const h = harness(); h.offline(); const response = await h.dispatch('/').response;
  assert.equal(response.status, 503); assert.match(await response.text(), /lang="ar"/);
});

test('cache storage failure never discards a successful network response', async () => {
  const h = harness({ failStorage: true });
  for (const [path, navigation] of [['/', true], ['/icon-192.png', false]]) {
    const event = h.dispatch(path, { navigation });
    assert.equal(await (await event.response).text(), 'fresh'); await event.done();
  }
  h.offline(); assert.equal((await h.dispatch('/').response).status, 503);
});

test('activation deletes only outdated Magnet OS caches', async () => {
  const h = harness();
  for (const name of ['magnet-os-v1', h.current, 'other-app-cache']) await h.caches.open(name);
  let done; h.listeners.activate({ waitUntil: p => { done = p; } }); await done;
  assert.deepEqual(h.deleted, ['magnet-os-v1']); assert.ok(h.stores.has('other-app-cache'));
});

test('APIs, cross-origin, authenticated, range, video, and mutation requests bypass interception', () => {
  const h = harness();
  for (const [path, options] of [
    ['/api', {}], ['/api/runtime-config', {}], ['/api/public-form?token=sample', {}],
    ['https://db.example/rest/v1/records', {}], ['/', { method: 'POST' }],
    ['/icon-192.png', { headers: { authorization: 'Bearer test-only' } }],
    ['/magnet-login.mp4', { navigation: false, headers: { range: 'bytes=0-100' } }],
    ['/magnet-login.mp4', { navigation: false }], ['/dynamic', { navigation: false }]
  ]) assert.equal(h.dispatch(path, options).response, undefined, path);
  assert.equal(h.calls.length, 0);
});

test('stale asset returns immediately and refresh is kept alive', async () => {
  const h = harness(); const cache = await h.caches.open(h.current);
  await cache.put('/icon-192.png', new Response('old'));
  let release; h.setNetwork(() => new Promise(resolve => { release = resolve; }));
  const event = h.dispatch('/icon-192.png', { navigation: false });
  assert.equal(await (await event.response).text(), 'old');
  release(new Response('new')); await event.done();
  assert.equal(await (await cache.match('/icon-192.png')).text(), 'new');
});

test('network failures use cached assets, cold misses return a network error', async () => {
  const h = harness(); const cache = await h.caches.open(h.current);
  await cache.put('/icon-192.png', new Response('old')); h.offline();
  const hit = h.dispatch('/icon-192.png', { navigation: false });
  assert.equal(await (await hit.response).text(), 'old'); await hit.done();
  const miss = h.dispatch('/missing.png', { navigation: false });
  assert.equal((await miss.response).type, 'error'); await miss.done();
});

test('failed, partial, and redirected responses cannot overwrite healthy cached content', async () => {
  const h = harness(); const cache = await h.caches.open(h.current);
  await cache.put('/icon-192.png', new Response('old'));
  for (const status of [404, 500, 206, 200]) {
    h.setNetwork(async () => { const r = new Response('bad', { status }); if (status === 200) Object.defineProperty(r, 'redirected', { value: true }); return r; });
    const event = h.dispatch('/icon-192.png', { navigation: false }); await event.response; await event.done();
    assert.equal(await (await cache.match('/icon-192.png')).text(), 'old');
  }
});

test('standalone HTML has its own fallback and cannot poison the main shell', async () => {
  const h = harness(); const root = h.dispatch('/'); await root.response; await root.done();
  h.setNetwork(async () => new Response('manual', { headers: { 'Content-Type': 'text/html' } }));
  const manual = h.dispatch('/Magnet-OS-Training.html'); await manual.response; await manual.done();
  h.offline();
  assert.equal(await (await h.dispatch('/').response).text(), 'fresh');
  assert.equal(await (await h.dispatch('/Magnet-OS-Training.html').response).text(), 'manual');
  assert.equal((await h.dispatch('/unknown.html').response).status, 503);
});

test('registration update failures settle, report retry and recover without unhandled rejection', async () => {
  const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const start = html.indexOf('        var updateInFlight=null;');
  const end = html.indexOf('        checkWorkerUpdate();', start);
  let fail = true, calls = 0;
  const window = {};
  const update = vm.runInNewContext(html.slice(start, end) + '\ncheckWorkerUpdate;', {
    window, Date, Promise,
    r: {update: async () => {calls++; if (fail) throw new Error('temporary offline');}},
  });
  const first=update(), second=update();
  assert.equal(first,second);
  await first;
  assert.equal(calls,1);assert.equal(window.__moServiceWorkerUpdate.state,'retry');
  fail=false;await update();
  assert.equal(calls,2);assert.equal(window.__moServiceWorkerUpdate.state,'checked');
});
