// Coding4Kids service worker — makes the app installable and fast.
const CACHE = 'c4k-v1';
const SHELL = [
  '/index.html', '/styles.css', '/auth.js', '/app.js',
  '/lessons.html', '/lessons.js', '/dashboard.html',
  '/favicon.svg', '/manifest.json', '/offline.html'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache the API or anything non-GET — accounts/progress must always be live.
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Page loads: network-first (always fresh, dynamic), fall back to cache, then offline page.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match('/offline.html')))
    );
    return;
  }

  // Static assets (css/js/svg/img): serve from cache fast, refresh in the background.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
