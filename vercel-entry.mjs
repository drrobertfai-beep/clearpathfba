// Vercel serverless entry (Build Output API v3, launcherType Nodejs).
//
// The deployment is a single function that serves both halves of the app:
//   - /api/*  → the Express app (the existing ClearPathFBA REST API)
//   - anything else → the SPA shell (index.html), for client-side routes
// Static assets (JS/CSS/icons/manifest/sw) are served by Vercel's filesystem
// handle from .vercel/output/static before this function is ever reached.
//
// The API sets `Content-Security-Policy: default-src 'none'` on its responses,
// so the SPA shell is deliberately served OUTSIDE the Express middleware chain
// (an HTML page with that CSP would block its own scripts/styles).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, bootstrap } from './server/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let bootPromise = null;
function boot() {
  if (!bootPromise) {
    bootPromise = bootstrap().catch((err) => {
      console.error('ClearPathFBA bootstrap failed:', err);
      throw err;
    });
  }
  return bootPromise;
}
// Kick off schema/seed on cold start so the first warm request is instant.
boot().catch(() => {});

let cachedHtml = null;
function spaHtml() {
  if (cachedHtml == null) {
    try {
      cachedHtml = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
    } catch {
      cachedHtml =
        '<!doctype html><html><head><meta charset="utf-8"><title>ClearPathFBA</title></head><body><p>App shell unavailable.</p></body></html>';
    }
  }
  return cachedHtml;
}

export default function handler(req, res) {
  boot()
    .then(() => {
      const url = (req.url || '/').split('?')[0];
      if (url === '/api' || url.startsWith('/api/')) {
        return app(req, res);
      }
      // SPA fallback for client-side routes (deep links, refreshes).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'text/plain');
        return res.end('Method Not Allowed');
      }
      const html = spaHtml();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(html);
    })
    .catch((err) => {
      console.error('ClearPathFBA handler error:', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    });
}
