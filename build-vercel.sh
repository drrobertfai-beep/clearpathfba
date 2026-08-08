#!/usr/bin/env bash
# Produce a Vercel Build Output API bundle (.vercel/output) for the app, then
# deploy it with:  bunx vercel deploy --prebuilt
#
# Layout of the bundle:
#   .vercel/output/static/                    -> client/dist (SPA + assets)
#   .vercel/output/functions/render.func/
#     index.mjs                               -> bun bundle of vercel-entry.mjs
#                                              (Express API + all pure-JS deps,
#                                              incl. pdfkit; its __dirname
#                                              literal is rewritten at build to
#                                              resolve to this directory)
#     index.html                              -> SPA shell (for client-side routes)
#     data/                                   -> pdfkit AFM/ICC font data, read
#                                              at runtime via __dirname + /data
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

# pdfkit's CJS build reads its AFM/ICC font data from disk relative to
# __dirname, and bun inlines that as a BUILD-MACHINE absolute path literal
# (e.g. var __dirname = "/home/.../server/node_modules/pdfkit/js"), which does
# not exist on Vercel's serverless runtime -> ENOENT on every PDF export.
# Rewrite the baked literal to resolve at runtime to the bundle's own
# directory (import.meta.dirname), and carry js/data alongside the bundle so
# the fonts resolve there. Fail the build loudly if the pattern ever
# disappears (pdfkit/bun upgrade), so this can't silently regress.
python3 - .vercel/output/functions/render.func/index.mjs <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s2, n = re.subn(r'var __dirname = "/[^"]*pdfkit/js";',
                "var __dirname = import.meta.dirname;", s)
if n == 0:
    sys.stderr.write("build-vercel.sh: pdfkit __dirname literal not found in "
                     "bundle; font-path fix not applied\n")
    sys.exit(1)
open(p, "w", encoding="utf-8").write(s2)
print(f"build-vercel.sh: rewrote pdfkit __dirname ({n}x) -> import.meta.dirname")
PY
cp -R server/node_modules/pdfkit/js/data .vercel/output/functions/render.func/data

cat > .vercel/output/functions/render.func/.vc-config.json <<'JSON'
{ "runtime": "nodejs22.x", "handler": "index.mjs", "launcherType": "Nodejs", "maxDuration": 30, "supportsResponseStreaming": true }
JSON
cat > .vercel/output/config.json <<'JSON'
{ "version": 3, "routes": [ { "handle": "filesystem" }, { "src": "/(.*)", "dest": "/render" } ] }
JSON
echo "done -> .vercel/output ready for: bunx vercel deploy --prebuilt"
