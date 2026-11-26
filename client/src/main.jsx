import React from 'react'; import {createRoot} from 'react-dom/client'; import './styles.css'; import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App/>);
// Tell the inline boot guard in index.html that the app mounted, so it does not
// show its "not loading" fallback over a working app.
window.__clearpathBoot = { ok: true };
// Service worker: app-shell cache for offline load (see public/sw.js).
// Registered in PRODUCTION builds only. Dev is intentionally excluded: Vite
// serves unbundled modules + HMR websockets there, and a cache-first SW makes
// dev stale. The offline guarantee targets the built app, which is what
// `vite build` + `vite preview` / deployment serve. The cache is versioned per
// build (stamped by vite.config.js), and a waiting worker is promoted at once,
// so a deploy replaces a stale shell instead of being served behind it. The
// offline data-point queue (offline.js) works regardless.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      // Ask the browser to check for a newer build now rather than on its own
      // schedule; a no-op offline.
      reg.update().catch(() => {});
    }).catch(() => {});
  });
}
