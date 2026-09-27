// Keeps the app working with no signal: app files are cached on first visit.
// Trip data comes from Supabase (or this device) and is not cached here.
const CACHE = 'rtp-v3';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './manifest.webmanifest']))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    // HTML: bypass the HTTP cache entirely so new builds arrive immediately;
    // hashed assets: network first with cache fallback for offline
    const isDoc = e.request.mode === 'navigate' || e.request.destination === 'document' || u.pathname.endsWith('.html') || u.pathname.endsWith('/');
    const req = isDoc ? new Request(e.request, { cache: 'no-store' }) : e.request;
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
  } else if (u.host === 'fonts.googleapis.com' || u.host === 'fonts.gstatic.com') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return res; })));
  }
});
