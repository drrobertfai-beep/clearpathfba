/* ClearPathFBA service worker — app-shell cache for offline load.
 *
 * The cache is tied to the build. `scripts/stamp-sw.mjs` fills in the build id and
 * the precache list at build time, so the cache name changes with every deploy and
 * the precache list contains that build's hashed JS/CSS (not just the HTML).
 *
 * Strategy:
 *  - Install: fetch the shell + this build's hashed assets in one atomic
 *    addAll(). If any of them is missing the install fails and the old worker
 *    keeps serving — a build can never leave a half-cached shell behind.
 *  - Navigations: network-first (with a timeout so a hanging host cannot show
 *    a white page). If the network fails or is slow, serve the cached shell —
 *    but only after checking that every JS/CSS it references is actually in
 *    the cache. A shell whose assets are gone would render a blank page, so in
 *    that case the user gets an honest fallback page with a recovery action.
 *  - Static assets: cache-first, then network, then a 504 (never a rejected
 *    fetch, which shows up as a blank page).
 *  - /api/** : NEVER cached (auth tokens + data freshness live there; offline
 *    data entry is handled by the client-side queue, not by API caching).
 *  - Versioned cache name + skipWaiting + clientsClaim: on redeploy the new SW
 *    takes over immediately and drops the previous build's cache.
 */
const BUILD = '__CLEARPATH_BUILD__';
const PRECACHE = __CLEARPATH_PRECACHE__;
const CACHE = 'clearpath-shell-' + BUILD;
const SHELL = './index.html';
const SYNC_TAG = 'clearpath-sync';
const NAV_TIMEOUT_MS = 8000;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Atomic: rejects if any entry is missing or not ok, which fails the
    // install and leaves the previous (working) worker in charge.
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Background Sync: the offline data-point queue lives in the page context
// (IndexedDB), so on a sync event for our tag we ask any open client page to
// flush. If no page is open the registration just resolves; the queue is
// still flushed by the window 'online' handler or the next manual sync the
// moment the app is next opened.
self.addEventListener('sync', (e) => {
  if (e.tag !== SYNC_TAG) return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        clients.forEach((c) => c.postMessage({ type: SYNC_TAG }));
      })
  );
});

/* Same-origin JS/CSS referenced by a shell document. */
function shellAssets(html) {
  const out = new Set();
  const re = /(?:src|href)\s*=\s*"([^"]+\.(?:js|css))"/g;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1];
    if (ref.startsWith('/assets/') || ref.startsWith('./assets/')) out.add(ref);
  }
  return [...out];
}

/* A cached shell is only usable if every file it references is also cached:
   otherwise the browser renders the HTML and then fails to boot the app. */
async function cachedShell(cache) {
  const hit = await cache.match(SHELL);
  if (!hit) return null;
  let html;
  try { html = await hit.clone().text(); } catch (err) { return null; }
  const assets = shellAssets(html);
  if (!assets.length) return null; // not a built shell — refuse to serve it
  for (const ref of assets) {
    if (!(await cache.match(ref))) return null;
  }
  return hit;
}

function offlinePage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ClearPathFBA</title></head>
<body style="margin:0;background:#f5f8f7;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#18313b">
<div style="max-width:560px;margin:12vh auto;padding:34px 30px;background:#fff;border:1px solid #dce8e5;border-radius:16px;text-align:center">
<div style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#197d6b">ClearPathFBA</div>
<h1 style="font-size:21px;margin:16px 0 8px;letter-spacing:-.3px">This device has an out-of-date copy of the app</h1>
<p style="font-size:14px;line-height:1.55;color:#5c7570;margin:0">The saved copy can no longer load because ClearPathFBA has been updated. Reconnect to the internet and reload to get the current version.</p>
<p style="font-size:14px;line-height:1.55;color:#5c7570;margin:12px 0 0">Nothing in your workspace has been lost, and any data points recorded offline are still queued on this device.</p>
<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:22px">
<button onclick="location.reload()" style="font:600 14px Inter,system-ui,sans-serif;padding:10px 18px;border-radius:8px;border:0;background:#197d6b;color:#fff;cursor:pointer">Reload</button>
<button onclick="cpReset()" style="font:600 14px Inter,system-ui,sans-serif;padding:10px 18px;border-radius:8px;border:1px solid #cfe0dc;background:#fff;color:#18313b;cursor:pointer">Clear saved copy and reload</button>
</div>
<p id="cp-status" style="font-size:12px;color:#8aa09b;margin:18px 0 0"></p>
</div>
<script>
function cpReset(){
  var jobs=[];
  if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){
    jobs.push(navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister()}))}).catch(function(){}));
  }
  if(window.caches&&caches.keys){
    jobs.push(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k)}))}).catch(function(){}));
  }
  Promise.all(jobs).then(function(){location.reload()},function(){location.reload()});
}
// If we are actually online, the fresh build is one reload away: try it once.
(function(){
  if(navigator.onLine===false) return;
  var last=0; try{last=Number(sessionStorage.getItem('cp_shell_retry')||0)}catch(e){}
  if(last&&Date.now()-last<20000) return;
  setTimeout(function(){
    fetch('/',{cache:'no-store'}).then(function(r){
      if(!r.ok) return;
      try{sessionStorage.setItem('cp_shell_retry',String(Date.now()))}catch(e){}
      location.reload();
    }).catch(function(){});
  },1200);
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: never cache
  if (url.pathname.startsWith('/api/')) return;    // API: never cache

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Only what the user actually loaded is written to the cache, so the
      // cached shell and the cached assets always belong to the same build.
      const network = fetch(req).catch(() => null);
      let timer;
      const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS); });
      const fresh = await Promise.race([network, slow]);
      clearTimeout(timer);
      if (fresh) {
        if (fresh.ok) cache.put(SHELL, fresh.clone()).catch(() => {});
        return fresh;
      }
      const shell = await cachedShell(cache);
      if (shell) return shell;
      return offlinePage();
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline', headers: { 'Cache-Control': 'no-store' } });
    }
  })());
});
