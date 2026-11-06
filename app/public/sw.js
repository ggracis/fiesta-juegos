// Panel service worker: runtime cache so play.html and its assets survive an internet drop. Hand-written, no manifest.
// Bump CACHE to drop everything cached by older versions (activate deletes other caches).
const CACHE = 'fiesta-v1';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const PLAY = new URL('play.html', self.registration.scope).href;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

const cacheable = (u) => (u.origin === location.origin || FONT_HOSTS.includes(u.hostname)) && !u.pathname.includes('/api/');
const key = (u) => u.origin + u.pathname; // pages are keyed without ?query (?setup=1, ?api=... all share play.html)

// The page tells us what it loaded (the very first load happened before this worker controlled it).
self.addEventListener('message', (e) => {
  const urls = (e.data?.precache ?? []).map((x) => { try { return new URL(x); } catch { return null; } }).filter((u) => u && cacheable(u));
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(urls.map(async (u) => {
    const r = await fetch(u.href);
    if (r.ok && !r.redirected) await c.put(/\.html?$|\/$/.test(u.pathname) ? key(u) : u.href, r);
  }))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || !cacheable(u)) return; // /api/* and anything foreign: network only, untouched
  if (req.mode === 'navigate') return void e.respondWith(page(req, u));
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } // hashed assets, content/*, fonts: cache-first
    return r;
  })));
});

// HTML: network first (so a redeploy reaches the panels), 3 s timeout, then the cached copy, then play.html.
async function page(req, u) {
  try {
    const r = await fetch(req, { signal: AbortSignal.timeout(3000) });
    if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key(u), copy)); }
    return r;
  } catch {
    return (await caches.match(key(u))) || (await caches.match(PLAY)) || Response.error();
  }
}
