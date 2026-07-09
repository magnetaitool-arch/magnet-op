/* Magnet OS — service worker (app-shell cache for offline + installability)
   STRATEGY:
   - Navigations / HTML  -> NETWORK-FIRST (so a new deploy shows up immediately;
     falls back to the cached shell only when offline). This removes the old
     "hard-refresh after every deploy" problem.
   - Same-origin static assets (png/js/css/manifest) -> stale-while-revalidate.
   - Everything cross-origin (Supabase REST/Auth, Resend, APIs) -> NEVER cached,
     always go to the network, so data is never served stale.
   Bump CACHE on each release; old caches are deleted on activate. */
const CACHE = 'magnet-os-v29';

self.addEventListener('install', e => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
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

  // Never touch cross-origin requests (Supabase, Resend, any API): always live.
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    // Network-first for the app shell so deploys are picked up instantly.
    e.respondWith(
      fetch(req).then(res => {
        try { caches.open(CACHE).then(c => c.put(req, res.clone())); } catch (_) {}
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
    );
    return;
  }

  // Static same-origin assets: stale-while-revalidate.
  e.respondWith(
    caches.open(CACHE).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { try { c.put(req, res.clone()); } catch (_) {} return res; }).catch(() => hit);
      return hit || net;
    }))
  );
});
