import React from 'react'; import {createRoot} from 'react-dom/client'; import './styles.css'; import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App/>);
// Service worker: app-shell cache for offline load (see public/sw.js).
// Registered in PRODUCTION builds only. Dev is intentionally excluded: Vite
// serves unbundled modules + HMR websockets there, and a cache-first SW makes
// dev stale. The offline guarantee targets the built app, which is what
// `vite build` + `vite preview` / deployment serve. Updates are picked up on
// the next visit because the SW uses a versioned cache name + skipWaiting +
// clientsClaim. The offline data-point queue (offline.js) works regardless.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
