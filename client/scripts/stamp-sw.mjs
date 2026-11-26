#!/usr/bin/env node
// Stamp dist/sw.js with the build id + precache list for THIS build.
//
// Run as part of `npm run build`, after `vite build` (Vite copies public/ into
// dist/ as the very last step, so a Vite plugin cannot stamp the file reliably).
//
// Why it matters: the service worker may only serve a cached app shell whose
// hashed JS/CSS are still in the cache. Recording the build id and precaching
// exactly the assets index.html references is what lets it detect a shell left
// behind by an earlier deploy and show an honest "out of date" page instead of
// a blank one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(ROOT, 'dist');
const swPath = path.join(outDir, 'sw.js');
const htmlPath = path.join(outDir, 'index.html');

for (const f of [swPath, htmlPath]) {
  if (!fs.existsSync(f)) {
    console.error(`stamp-sw: missing ${f} — run \`vite build\` first`);
    process.exit(1);
  }
}

const html = fs.readFileSync(htmlPath, 'utf8');
const assets = [...new Set(
  [...html.matchAll(/(?:src|href)\s*=\s*"(\/assets\/[^"]+)"/g)].map((m) => m[1])
)];
if (!assets.length) {
  console.error('stamp-sw: no hashed assets found in dist/index.html');
  process.exit(1);
}
for (const asset of assets) {
  if (!fs.existsSync(path.join(outDir, asset))) {
    console.error(`stamp-sw: ${asset} is referenced by index.html but missing from dist`);
    process.exit(1);
  }
}

const build = crypto.createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 12);
const precache = [
  './', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  ...assets,
];

let sw = fs.readFileSync(swPath, 'utf8');
if (!sw.includes('__CLEARPATH_BUILD__') || !sw.includes('__CLEARPATH_PRECACHE__')) {
  console.error('stamp-sw: placeholders missing from dist/sw.js — cache would not match the build');
  process.exit(1);
}
sw = sw.replaceAll('__CLEARPATH_BUILD__', build).replaceAll('__CLEARPATH_PRECACHE__', JSON.stringify(precache, null, 2));
fs.writeFileSync(swPath, sw);
console.log(`stamp-sw: sw.js stamped with build ${build} (${assets.length} hashed assets precached)`);
