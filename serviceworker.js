/* Magnet OS — service worker (app-shell cache for offline + installability)
   STRATEGY:
   - Navigations / HTML  -> NETWORK-FIRST (so a new deploy shows up immediately;
     falls back to the cached shell only when offline). This removes the old
     "hard-refresh after every deploy" problem.
   - Same-origin static assets (png/js/css/manifest) -> stale-while-revalidate.
   - Everything cross-origin (Supabase REST/Auth, Resend, APIs) -> NEVER cached,
     always go to the network, so data is never served stale.
   Bump CACHE on each release; old caches are deleted on activate. */
const CACHE = 'magnet-os-v48';
const CACHE_PREFIX = 'magnet-os-';
const SHELL = '/index.html';

// Cache storage can be unavailable (private browsing, quota, or eviction).
// It must never turn a successful network response into a failed request.
async function cached(key) {
  try { return await (await caches.open(CACHE)).match(key); } catch (_) { return undefined; }
}
async function remember(key, response) {
  try { await (await caches.open(CACHE)).put(key, response); } catch (_) {}
}
function offlinePage() {
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Magnet OS — Offline</title><body style="background:#070807;color:#f3f5ef;font:18px system-ui;padding:32px"><main><h1>Magnet OS</h1><p>You are offline. Reconnect and reload to open your workspace.</p><p lang="ar" dir="rtl">أنت غير متصل بالإنترنت. أعد الاتصال ثم حدّث الصفحة لفتح مساحة العمل.</p><a href="/" style="background:#c8f31e;color:#070807;padding:12px 20px;border:0;border-radius:8px;font:inherit">Retry / إعادة المحاولة</a></main></body></html>', {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('install', e => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Never touch cross-origin requests (Supabase, Resend): always live.
  if (url.origin !== self.location.origin) return;

  // Same-origin server endpoints are live application state too. In particular,
  // /api/runtime-config chooses the Supabase project for this deployment. Caching
  // it can pin one laptop to an old/retired database or the wrong environment.
  // Let the browser perform these requests normally and honour the endpoint's
  // own no-store headers; never put an /api response in the app-shell cache.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  // Media range responses cannot be stored by Cache.put. Protected requests
  // must never be persisted in a shared app-shell cache either.
  if (req.headers.has('range') || req.headers.has('authorization')) return;

  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    // Query links use the same static shell. Do not retain invite/review tokens
    // in cache keys. Separate HTML documents keep their own offline response.
    const isShell = url.pathname === '/' || url.pathname === SHELL || !url.pathname.includes('.');
    const key = isShell ? SHELL : req;
    let write = Promise.resolve();
    const response = fetch(req).then(res => {
      if (res.ok && res.status !== 206 && !res.redirected && (res.headers.get('content-type') || '').includes('text/html')) {
        // Clone before handing the response body to the browser.
        write = remember(key, res.clone());
      }
      return res;
    }).catch(async () => (await cached(key)) || offlinePage());
    e.respondWith(response);
    e.waitUntil(response.then(() => write).catch(() => {}));
    return;
  }

  // Only shell assets use stale-while-revalidate; video stays on the network.
  if (!/\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/.test(url.pathname) && url.pathname !== '/manifest.json') return;
  const hit = cached(req);
  let write = Promise.resolve();
  const network = fetch(req).then(res => {
    if (res.ok && res.status !== 206 && !res.redirected) write = remember(req, res.clone());
    return res;
  });
  // Attach rejection handling immediately, including when a cache hit wins.
  const response = network.catch(async () => (await hit) || Response.error());
  e.respondWith(hit.then(value => value || response));
  e.waitUntil(response.then(() => write).catch(() => {}));
});
