// KidVibers service worker - installable + offline, but always fresh when online.
const CACHE = 'c4k-v3';
const SHELL = ['/index.html', '/styles.css', '/auth.js', '/app.js', '/favicon.svg', '/manifest.json', '/offline.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never touch the API or non-GET - accounts/progress must always be live.
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;  // let cross-origin (fonts, QR) go straight to network

  // Network-first: always serve the freshest code/pages when online; cache is the offline fallback.
  // For page navigations, bypass the browser's HTTP cache entirely so a new deploy always shows
  // up immediately (otherwise an old index.html cached by the browser keeps being served).
  const fetchOpts = e.request.mode === 'navigate' ? { cache: 'no-store' } : undefined;
  e.respondWith(
    fetch(e.request, fetchOpts).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() =>
      caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/offline.html') : undefined))
    )
  );
});
