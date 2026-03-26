// Last Man Standing — Service Worker v11
// Strategy: network-first with cache fallback (stale-while-revalidate)

const SHELL_CACHE = 'lms-shell-v11';
const DATA_CACHE = 'lms-data-v11';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Install: pre-cache shell assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches, then take control immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API data: network-first, cache successful response, fallback to cache or error response
  if (url.pathname === '/api/data') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(DATA_CACHE).then(cache => cache.put('/api/data', clone));
          }
          return res;
        })
        .catch(() =>
          // Try cache — use a stable key (no query params) so cache hits work
          caches.open(DATA_CACHE).then(cache => cache.match('/api/data')).then(cached => {
            if (cached) return cached;
            // No cache available — return a proper error response instead of undefined
            return new Response(JSON.stringify({ error: 'offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          })
        )
    );
    return;
  }

  // Shell assets: network-first, fall back to cache
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok && SHELL_ASSETS.some(a => url.pathname === a || url.pathname.endsWith(a))) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then(cached => {
          if (cached) return cached;
          // No cache — return a basic offline page for navigation requests
          if (event.request.mode === 'navigate') {
            return new Response('<html><body style="background:#0a0a0f;color:#e8e8ed;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Offline</h2><p>Check your connection and try again</p></div></body></html>', {
              status: 503,
              headers: { 'Content-Type': 'text/html' }
            });
          }
          return new Response('', { status: 503 });
        })
      )
  );
});
