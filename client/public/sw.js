/* ClearPathFBA service worker — app-shell cache for offline load.
 *
 * Strategy:
 *  - Static assets (hashed JS/CSS, icons, manifest): cache-first, populated at
 *    runtime on first fetch. Vite hashes filenames, so a redeploy naturally
 *    fetches new files and the old ones age out of the versioned cache.
 *  - Navigation requests: network-first, fall back to the cached shell so the
 *    app loads offline after a first visit. Successful navigations refresh the
 *    cached index.html so the shell stays current.
 *  - /api/** : NEVER cached (auth tokens + data freshness live there; offline
 *    data entry is handled by the client-side queue, not by API caching).
 *  - Versioned cache name + skipWaiting + clientsClaim: on redeploy the new SW
 *    takes over immediately and swaps the cache.
 */
const CACHE = 'clearpath-shell-v3';
const SYNC_TAG = 'clearpath-sync';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Background Sync: the offline data-point queue lives in the page context
// (IndexedDB), so on a sync event for our tag we ask any open client page to
// flush. If no page is open the registration just resolves; the queue is
// still flushed by the window 'online' handler or the next manual sync the
// moment the app is next opened. A sync that fires while the page is offline
// or while a flush is already running is a no-op in the page's handler.
self.addEventListener('sync', (e) => {
  if (e.tag !== SYNC_TAG) return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        clients.forEach((c) => c.postMessage({ type: SYNC_TAG }));
      })
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: never cache
  if (url.pathname.startsWith('/api/')) return;    // API: never cache

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
