#!/usr/bin/env bash
set -Eeuo pipefail

readonly PREFIX="zevanory-rollback-secret-probe-"
readonly NONCE="zevanory-b01-rollback-secret-probe-v1:"
readonly WRANGLER="wrangler@4.143.0"
readonly NPX_BIN="${NPX_BIN:-npx}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-1b26415802588185a86c1d4d3ebf5bdb}"
readonly CONFIG="sandbox/rollback-secret-probe/wrangler.toml"
readonly WORKER_NAME="${WORKER_NAME:-${PREFIX}${GITHUB_RUN_ID:-}}"
readonly TOKEN="${CLOUDFLARE_SANDBOX_PROBE_TOKEN:-}"
readonly ATTEMPTS="${PROBE_ATTEMPTS:-10}"
readonly SLEEP_SECONDS="${PROBE_SLEEP_SECONDS:-2}"

RESULT="NO"
WORKER_CREATED=0
TMP_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
TMP_DIR="${TMP_BASE}/b01-rollback-secret-probe-${GITHUB_RUN_ID:-unknown}-$$"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"

validate_worker_name() {
  [[ "$WORKER_NAME" =~ ^zevanory-rollback-secret-probe-[0-9]+$ ]]
}

cleanup() {
  local cleanup_status=0
  if [[ "$WORKER_CREATED" == "1" ]]; then
    if ! validate_worker_name; then
      echo "CLEANUP_REFUSED_INVALID_WORKER_NAME" >&2
      return 1
    fi
    if CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
      "$NPX_BIN" --yes "$WRANGLER" delete "$WORKER_NAME" --config "$CONFIG" --force \
      >/dev/null 2>&1; then
      if [[ -n "${GITHUB_ENV:-}" ]]; then
        printf 'B01_CLEANUP_DONE=1\n' >> "$GITHUB_ENV"
      fi
    else
      cleanup_status=1
    fi
  fi
  rm -rf -- "$TMP_DIR"
  return "$cleanup_status"
}

finalize() {
  local status=$?
  local cleanup_status=0
  local final="NO"
  trap - EXIT
  set +e
  cleanup
  cleanup_status=$?
  if [[ "$status" == "0" && "$cleanup_status" == "0" && "$RESULT" == "YES" ]]; then
    final="YES"
  else
    status=1
  fi
  printf 'ROLLBACK_SECRET_VALUE_RESTORED=%s\n' "$final"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'rollback_secret_value_restored=%s\n' "$final" >> "$GITHUB_OUTPUT"
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf 'ROLLBACK_SECRET_VALUE_RESTORED=%s\n' "$final" >> "$GITHUB_STEP_SUMMARY"
  fi
  unset VALUE_A VALUE_B
  exit "$status"
}
trap finalize EXIT

fail() {
  echo "$1" >&2
  exit 1
}

sha256_value() {
  printf '%s' "$NONCE$1" | openssl dgst -sha256 -r | awk '{print $1}'
}

read_active_version() {
  local destination="$1"
  local code
  code="$("$CURL_BIN" --silent --show-error --output "$destination" --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    --header "Authorization: Bearer $TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments")"
  [[ "$code" == "200" ]] || fail "DEPLOYMENTS_READBACK_HTTP_${code}"
  "$PYTHON_BIN" - "$destination" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
deployments = data.get("result", {}).get("deployments", [])
for deployment in deployments:
    for version in deployment.get("versions", []):
        if version.get("percentage") in (None, 100):
            value = version.get("version_id")
            if value:
                print(value)
                raise SystemExit(0)
raise SystemExit("ACTIVE_VERSION_MISSING")
PY
}

read_probe() {
  local destination="$1"
  local code
  code="$("$CURL_BIN" --silent --show-error --output "$destination" --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 "${WORKER_URL}/probe")"
  if [[ "$code" != "200" ]]; then
    echo "PROBE_HTTP_STATUS=${code}" >&2
    return 1
  fi
  tr -d '\r\n' < "$destination"
}

validate_worker_name || fail "WORKER_NAME_REFUSED"
[[ -n "$TOKEN" ]] || fail "CLOUDFLARE_SANDBOX_PROBE_TOKEN_MISSING"
[[ "$ACCOUNT_ID" == "1b26415802588185a86c1d4d3ebf5bdb" ]] || fail "CLOUDFLARE_ACCOUNT_ID_REFUSED"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "PROBE_ATTEMPTS_INVALID"

VALUE_A="$(openssl rand -hex 32)"
VALUE_B="$(openssl rand -hex 32)"
[[ "$VALUE_A" != "$VALUE_B" ]] || fail "PROBE_VALUES_COLLIDED"
HASH_A="$(sha256_value "$VALUE_A")"
HASH_B="$(sha256_value "$VALUE_B")"

WORKER_CREATED=1
CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  "$NPX_BIN" --yes "$WRANGLER" deploy --name "$WORKER_NAME" --config "$CONFIG" \
  > "$TMP_DIR/deploy.log" 2>&1
WORKER_URL="$(grep -Eo "https://${WORKER_NAME}\.[A-Za-z0-9-]+\.workers\.dev" "$TMP_DIR/deploy.log" | tail -1)"
[[ -n "$WORKER_URL" ]] || fail "WORKER_URL_MISSING"

printf '%s' "$VALUE_A" | CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  "$NPX_BIN" --yes "$WRANGLER" secret put PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" \
  >/dev/null
VERSION_A="$(read_active_version "$TMP_DIR/deployments-a.json")"
[[ -n "$VERSION_A" ]] || fail "VERSION_A_MISSING"

printf '%s' "$VALUE_B" | CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  "$NPX_BIN" --yes "$WRANGLER" secret put PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" \
  >/dev/null

observed_b=""
for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
  if observed_b="$(read_probe "$TMP_DIR/probe-b.txt")" && [[ "$observed_b" == "$HASH_B" ]]; then
    break
  fi
  observed_b=""
  sleep "$SLEEP_SECONDS"
done
[[ "$observed_b" == "$HASH_B" ]] || fail "PROBE_B_NOT_OBSERVED"
echo "PROBE_B_DIGEST=${observed_b}"

CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  "$NPX_BIN" --yes "$WRANGLER" rollback "$VERSION_A" --name "$WORKER_NAME" --config "$CONFIG" --yes \
  >/dev/null

ACTIVE_VERSION="$(read_active_version "$TMP_DIR/deployments-rollback.json")"
observed_a=""
for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
  if observed_a="$(read_probe "$TMP_DIR/probe-a.txt")" && [[ "$observed_a" == "$HASH_A" ]]; then
    break
  fi
  sleep "$SLEEP_SECONDS"
done
echo "PROBE_A_EXPECTED_DIGEST=${HASH_A}"
echo "PROBE_AFTER_ROLLBACK_DIGEST=${observed_a}"
echo "ROLLBACK_ACTIVE_VERSION=${ACTIVE_VERSION}"

if [[ "$ACTIVE_VERSION" == "$VERSION_A" && "$observed_a" == "$HASH_A" ]]; then
  RESULT="YES"
  exit 0
fi
exit 1
