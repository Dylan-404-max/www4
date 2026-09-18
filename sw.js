const CACHE_NAME = 'timberpro-v2.3';

// Compute the base path this SW is running from (e.g. "/timberpro/" on GH Pages, "/" on CF Pages)
const BASE_PATH = new URL('./', self.location).pathname;

const STATIC_ASSETS = [
    BASE_PATH,
    BASE_PATH + 'index.html',
    BASE_PATH + 'styles.css',
    BASE_PATH + 'app.js',
    BASE_PATH + 'manifest.json',
    BASE_PATH + 'icons/icon.svg',
    BASE_PATH + 'icons/icon-maskable.svg'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(c => c.addAll(STATIC_ASSETS).catch(err => {
                console.warn('[SW] Some assets failed to cache:', err);
                // Cache what we can — don't fail install
                return Promise.all(
                    STATIC_ASSETS.map(url =>
                        c.add(url).catch(() => {})
                    )
                );
            }))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Only handle same-origin GET requests
    if (e.request.method !== 'GET') return;
    if (url.origin !== location.origin) return;

    // Never cache API calls — always network-first with offline JSON fallback
    if (url.pathname.includes('/api/')) {
        e.respondWith(
            fetch(e.request).catch(() =>
                new Response(
                    JSON.stringify({ success: false, offline: true, error: 'You are offline' }),
                    { headers: { 'Content-Type': 'application/json' } }
                )
            )
        );
        return;
    }

    // Static assets: cache-first
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return res;
            }).catch(() => cached);
        })
    );
});
