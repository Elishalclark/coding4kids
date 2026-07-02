// KidVibers service worker - installable + offline, but always fresh when online.
const CACHE = 'c4k-v3';
// Core shell + lesson pages so kids can start coding even if wifi drops (great for libraries).
const SHELL = [
  '/index.html', '/styles.css', '/auth.js', '/app.js', '/favicon.svg', '/manifest.json', '/offline.html',
  '/lessons.html', '/lessons.js', '/dashboard.html', '/games.html'
];

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
  if (e.request.method !== 'GET') return;

  // The lesson list is public read-only data — cache it so lessons work offline.
  if (url.pathname === '/api/lessons') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // All other API calls must always be live (accounts/progress).
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;  // fonts, QR, etc. go straight to network

  // Network-first for everything else; cache is the offline fallback.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() =>
      caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/offline.html') : undefined))
    )
  );
});
