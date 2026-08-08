#!/usr/bin/env bash
# Build and deploy ClearPathFBA to Vercel, then verify the live deployment.
# Run from the repository root (or invoke this script by path).
#
# app.clearpathfba.com is a PROJECT-ATTACHED domain on the clearpathfba-app
# project: production deploys attach to it automatically, so there is no alias
# step and none should be added (a `vercel alias set` would conflict). The
# GitHub integration is unlinked — deploys are exclusively manual via this
# script. After deploying, the script verifies that (a) the new deployment and
# the app domain serve the same bundle asset, and (b) /api/health answers with
# ok:true and an Express x-powered-by header.
set -euo pipefail
cd "$(dirname "$0")"
umask 077

# Credentials may be supplied by the environment or by the lead's local secret files.
if [[ -z "${VERCEL_TOKEN:-}" && -r /home/agent-lead/.vercel-token ]]; then
  VERCEL_TOKEN="$(< /home/agent-lead/.vercel-token)"
fi
if [[ -z "${DATABASE_URL:-}" && -r /home/agent-lead/.neon-db-url ]]; then
  DATABASE_URL="$(< /home/agent-lead/.neon-db-url)"
fi
: "${VERCEL_TOKEN:?set VERCEL_TOKEN or provide /home/agent-lead/.vercel-token}"
: "${DATABASE_URL:?set DATABASE_URL or provide /home/agent-lead/.neon-db-url}"
VERCEL_SCOPE="${VERCEL_SCOPE:-drrobertfai-2367s-projects}"
VERCEL=(bunx vercel)
DOMAIN="app.clearpathfba.com"
# Keep secrets out of command output and diagnostics.
export VERCEL_TOKEN DATABASE_URL

echo "==> building Vercel bundle"
bash ./build-vercel.sh

LOCAL_ASSET="$(grep -oE "assets/index-[^\"' ]+\.js" .vercel/output/static/index.html | head -1)"
if [[ -z "$LOCAL_ASSET" ]]; then
  echo "error: could not find local index asset in .vercel/output/static/index.html" >&2
  exit 1
fi
echo "    local asset:  $LOCAL_ASSET"

echo "==> deploying production bundle (scope: $VERCEL_SCOPE)"
DEPLOY_OUT="$(mktemp)"
trap 'rm -f "$DEPLOY_OUT"' EXIT
if ! "${VERCEL[@]}" deploy --prebuilt --yes --prod --token "$VERCEL_TOKEN" \
    --name clearpathfba-app --scope "$VERCEL_SCOPE" -e "DATABASE_URL=$DATABASE_URL" \
    >"$DEPLOY_OUT" 2>&1; then
  echo "error: Vercel deployment failed" >&2
  cat "$DEPLOY_OUT" >&2
  exit 1
fi
NEW_URL="$(grep -oE 'https://[A-Za-z0-9._-]+\.vercel\.app' "$DEPLOY_OUT" | tail -1)"
if [[ -z "$NEW_URL" ]]; then
  echo "error: deployment succeeded but no .vercel.app URL was found" >&2
  cat "$DEPLOY_OUT" >&2
  exit 1
fi
echo "    deployment:   $NEW_URL"

index_asset_from_url() {
  local url="$1" html asset
  html="$(curl -fsSL --retry 3 --retry-delay 2 "$url/")"
  asset="$(printf '%s' "$html" | grep -oE "assets/index-[^\"' ]+\.js" | head -1)"
  [[ -n "$asset" ]] || { echo "error: no index asset found at $url" >&2; return 1; }
  printf '%s' "$asset"
}

fail=0
echo "==> verifying deployment and app domain serve the same bundle"
DEPLOY_ASSET="$(index_asset_from_url "$NEW_URL")" || fail=1
DOMAIN_ASSET="$(index_asset_from_url "https://$DOMAIN")" || fail=1
echo "    deployment:   $NEW_URL/$DEPLOY_ASSET"
echo "    domain:       https://$DOMAIN/$DOMAIN_ASSET"
if [[ "$LOCAL_ASSET" != "$DEPLOY_ASSET" ]]; then
  echo "FAIL: built bundle ($LOCAL_ASSET) does not match the deployed bundle ($DEPLOY_ASSET)" >&2
  fail=1
fi
if [[ "$DOMAIN_ASSET" != "$DEPLOY_ASSET" ]]; then
  echo "FAIL: $DOMAIN serves $DOMAIN_ASSET but the new deployment is $DEPLOY_ASSET (domain not attached to this deployment?)" >&2
  fail=1
fi

echo "==> verifying https://$DOMAIN/api/health"
HEALTH_BODY="$(curl -fsSL --retry 3 --retry-delay 2 "https://$DOMAIN/api/health")" \
  || { echo "FAIL: /api/health not reachable on $DOMAIN" >&2; fail=1; HEALTH_BODY=""; }
if [[ -n "$HEALTH_BODY" ]]; then
  echo "    body: $HEALTH_BODY"
  if ! grep -q '"ok":true' <<<"$HEALTH_BODY"; then
    echo "FAIL: /api/health does not report ok:true" >&2
    fail=1
  fi
fi
XPB="$(curl -fsSI "https://$DOMAIN/api/health" | grep -i '^x-powered-by:' | tr -d '\r' || true)"
echo "    header: ${XPB:-<missing>}"
if ! grep -qi 'express' <<<"$XPB"; then
  echo "FAIL: /api/health missing 'x-powered-by: Express' header" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "FAIL: deployment verification did not pass — do not treat this deployment as live" >&2
  exit 1
fi
echo "PASS: $DOMAIN serves the newest deployment asset ($DEPLOY_ASSET) and /api/health is OK"
