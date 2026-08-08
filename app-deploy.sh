#!/usr/bin/env bash
# Build and deploy ClearPathFBA, then repoint the standalone production alias.
# Run from the repository root (or invoke this script by path).
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
ALIAS_DOMAIN="app.clearpathfba.com"

# Keep secrets out of command output and diagnostics.
export VERCEL_TOKEN DATABASE_URL

echo "==> building Vercel bundle"
bash ./build-vercel.sh

LOCAL_ASSET="$(grep -oE 'assets/index-[^\"'"'"' ]+\.js' .vercel/output/static/index.html | head -1)"
if [[ -z "$LOCAL_ASSET" ]]; then
  echo "error: could not find local index asset in .vercel/output/static/index.html" >&2
  exit 1
fi

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
echo "    deployment: $NEW_URL"

echo "==> repointing $ALIAS_DOMAIN"
if ! "${VERCEL[@]}" alias set "$NEW_URL" "$ALIAS_DOMAIN" --token "$VERCEL_TOKEN" --scope "$VERCEL_SCOPE" >/dev/null; then
  echo "error: alias update failed; existing alias was not intentionally changed by this script" >&2
  exit 1
fi
echo "    alias: $ALIAS_DOMAIN -> $NEW_URL"

index_asset_from_url() {
  local url="$1" html asset
  html="$(curl -fsSL --retry 2 --retry-delay 1 "$url/")"
  asset="$(printf '%s' "$html" | grep -oE 'assets/index-[^\"'"'"' ]+\.js' | head -1)"
  [[ -n "$asset" ]] || { echo "error: no index asset found at $url" >&2; return 1; }
  printf '%s' "$asset"
}

echo "==> verifying alias and deployment serve the same bundle"
ALIAS_ASSET="$(index_asset_from_url "https://$ALIAS_DOMAIN")"
DEPLOY_ASSET="$(index_asset_from_url "$NEW_URL")"
echo "    local:      $LOCAL_ASSET"
echo "    deployment: $NEW_URL/$DEPLOY_ASSET"
echo "    alias:      https://$ALIAS_DOMAIN/$ALIAS_ASSET"
if [[ "$LOCAL_ASSET" != "$DEPLOY_ASSET" || "$ALIAS_ASSET" != "$DEPLOY_ASSET" ]]; then
  echo "error: asset mismatch — refusing to report a successful deployment" >&2
  exit 1
fi
echo "PASS: $ALIAS_DOMAIN serves the newest deployment asset ($DEPLOY_ASSET)"
