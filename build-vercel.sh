#!/usr/bin/env bash
# Produce a Vercel Build Output API bundle (.vercel/output) for the app, then
# deploy it with:  bunx vercel deploy --prebuilt
#
# Layout of the bundle:
#   .vercel/output/static/                    -> client/dist (SPA + assets)
#   .vercel/output/functions/render.func/
#     index.mjs                               -> bun bundle of vercel-entry.mjs
#                                              (Express API + all pure-JS deps)
#     index.html                              -> SPA shell (for client-side routes)
#     node_modules/pdfkit/                    -> pdfkit ships fonts read from
#                                              disk via __dirname; keep it
#                                              external and carry the package
#     .vc-config.json
#   .vercel/output/config.json                -> filesystem first, else /render
set -euo pipefail
cd "$(dirname "$0")"
umask 002

echo "[1/3] client build (vite)"
if [ ! -d client/node_modules ]; then (cd client && npm install --no-audit --no-fund); fi
(cd client && npm run build)

echo "[2/3] assemble .vercel/output (Build Output API v3)"
rm -rf .vercel/output
mkdir -p .vercel/output/static
cp -R client/dist/. .vercel/output/static/

mkdir -p .vercel/output/functions/render.func
cp .vercel/output/static/index.html .vercel/output/functions/render.func/index.html

echo "[3/3] bundle server + deps into the render function"
if [ ! -d server/node_modules ]; then (cd server && npm install --no-audit --no-fund); fi
bun build vercel-entry.mjs --target node \
  --external better-sqlite3 \
  --outfile .vercel/output/functions/render.func/index.mjs

# pdfkit's CJS build reads its AFM font files from disk relative to __dirname
# (which bun rewrites to the bundle's directory), so carry js/data alongside.
cp -R server/node_modules/pdfkit/js/data .vercel/output/functions/render.func/data

cat > .vercel/output/functions/render.func/.vc-config.json <<'JSON'
{ "runtime": "nodejs22.x", "handler": "index.mjs", "launcherType": "Nodejs", "maxDuration": 30, "supportsResponseStreaming": true }
JSON
cat > .vercel/output/config.json <<'JSON'
{ "version": 3, "routes": [ { "handle": "filesystem" }, { "src": "/(.*)", "dest": "/render" } ] }
JSON
echo "done -> .vercel/output ready for: bunx vercel deploy --prebuilt"
