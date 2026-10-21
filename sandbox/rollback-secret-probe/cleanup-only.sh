#!/usr/bin/env bash
set -Eeuo pipefail

readonly PREFIX="zevanory-rollback-secret-probe-"
readonly WORKER_NAME="${PREFIX}${GITHUB_RUN_ID:-}"
readonly CONFIG="sandbox/rollback-secret-probe/wrangler.toml"
readonly TOKEN="${CLOUDFLARE_SANDBOX_PROBE_TOKEN:-}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

[[ "$WORKER_NAME" =~ ^zevanory-rollback-secret-probe-[0-9]+$ ]] || {
  echo "CLEANUP_REFUSED_INVALID_WORKER_NAME" >&2
  exit 1
}
[[ -n "$TOKEN" ]] || {
  echo "CLOUDFLARE_SANDBOX_PROBE_TOKEN_MISSING" >&2
  exit 1
}
[[ "$ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "CLOUDFLARE_SANDBOX_ACCOUNT_ID_INVALID" >&2
  exit 1
}
[[ "$ACCOUNT_ID" != "1b26415802588185a86c1d4d3ebf5bdb" ]] || {
  echo "CLOUDFLARE_PRODUCTION_ACCOUNT_REFUSED" >&2
  exit 1
}

if [[ "${B01_CLEANUP_DONE:-}" == "1" ]]; then
  echo "B01_CLEANUP_ALREADY_DONE=YES"
  exit 0
fi

CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  npx --yes wrangler@4.143.0 delete "$WORKER_NAME" --config "$CONFIG" --force \
  >/dev/null
echo "B01_CLEANUP_DONE=YES"
