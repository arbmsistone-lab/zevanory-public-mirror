#!/usr/bin/env bash
# Ensaio B01-R (Sol, Ordem 046 R2): provar a RECUPERAÇÃO depois de um retorno automático, no Worker
# descartável da conta Zevanory (o mesmo do ensaio B01, criado pelo proprietário; token Editor escopado).
#
# Sequência, espelhando a falha de produção:
#   A = "token antigo"   -> secret put, versão VA ativa
#   B = "token novo"     -> secret put, versão VB ativa, digest de B observado
#   retorno automático   -> rollback para VA, digest de A observado
#   controle negativo    -> secret put de C tem de ser RECUSADO com 10215 (condição real reproduzida)
#   identificação        -> a versão mais recente por "number" tem de ser exatamente VB
#   recuperação          -> scripts/ops/worker-version-recover.sh (o MESMO script do modo recover de produção)
#   certificação         -> versão ativa = VB e o Worker serve o digest de B
#   limpeza              -> secret delete (já permitido, a mais recente está ativa) + /probe 503
# Resultado: RECOVERY_CERTIFIED=YES só se tudo acima for observado; qualquer outra saída = INCONCLUSIVE.
set -Eeuo pipefail

readonly PROBE_WORKER="zevanory-rollback-secret-probe"
readonly NONCE="zevanory-b01-rollback-secret-probe-v1:"
readonly WRANGLER="wrangler@4.143.0"
readonly NPX_BIN="${NPX_BIN:-npx}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly RECOVER_SCRIPT="${RECOVER_SCRIPT:-scripts/ops/worker-version-recover.sh}"
readonly ZEVANORY_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
readonly CONFIG="sandbox/rollback-secret-probe/wrangler.toml"
readonly WORKER_NAME="${WORKER_NAME:-$PROBE_WORKER}"
TOKEN="$(printf '%s' "${CLOUDFLARE_SANDBOX_PROBE_TOKEN:-}" | tr -d '[:space:]')"
readonly TOKEN
readonly ATTEMPTS="${PROBE_ATTEMPTS:-30}"
readonly SLEEP_SECONDS="${PROBE_SLEEP_SECONDS:-2}"

RESULT="INCONCLUSIVE"
SECRET_WRITTEN=0
TMP_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
TMP_DIR="${TMP_BASE}/b01-recovery-probe-${GITHUB_RUN_ID:-unknown}-$$"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"

fail() { echo "$1" >&2; exit 1; }

wr() {
  CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" "$NPX_BIN" --yes "$WRANGLER" "$@"
}

read_active_version() {
  local out="$1" code
  code="$("$CURL_BIN" --silent --show-error --output "$out" --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 --header "Authorization: Bearer $TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments")"
  [[ "$code" == "200" ]] || fail "DEPLOYMENTS_READBACK_HTTP_${code}"
  jq -r '(.result.deployments // []) as $d
    | if ($d|length)==0 then empty
      else ($d[0].versions // []) as $v
        | if ($v|length)!=1 or ($v[0].percentage|type)!="number" or $v[0].percentage!=100 then empty
          else ($v[0].version_id // empty) end
      end' "$out"
}

read_probe() {
  local out="$1" code
  code="$("$CURL_BIN" --silent --show-error --output "$out" --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 "${WORKER_URL}/probe")"
  [[ "$code" == "200" ]] || return 1
  tr -d '\r\n' < "$out"
}

wait_digest() {
  local expected="$1" tag="$2" seen="" attempt
  for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    if seen="$(read_probe "$TMP_DIR/probe-$tag.txt")" && [[ "$seen" == "$expected" ]]; then
      echo "PROBE_${tag}_DIGEST=$seen"; return 0
    fi
    sleep "$SLEEP_SECONDS"
  done
  echo "PROBE_${tag}_NOT_OBSERVED last=${seen:-none}" >&2
  return 1
}

sha256_value() { printf '%s' "$NONCE$1" | openssl dgst -sha256 -r | awk '{print $1}'; }

cleanup_certified() {
  [[ -n "${WORKER_URL:-}" ]] || return 1
  local attempt code
  for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    code="$("$CURL_BIN" --silent --show-error --output "$TMP_DIR/probe-cleanup.txt" --write-out '%{http_code}' \
      --connect-timeout 10 --max-time 30 "${WORKER_URL}/probe" || true)"
    if [[ "$code" == "503" ]] && grep -qx "probe secret unavailable" "$TMP_DIR/probe-cleanup.txt"; then
      echo "B01R_CLEANUP_CERTIFIED=probe_503"; return 0
    fi
    sleep "$SLEEP_SECONDS"
  done
  return 1
}

cleanup() {
  local status=0
  if [[ "$SECRET_WRITTEN" == "1" ]]; then
    [[ "$WORKER_NAME" == "$PROBE_WORKER" ]] || return 1
    if wr secret delete PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" >/dev/null 2>&1 </dev/null && cleanup_certified; then
      [[ -z "${GITHUB_ENV:-}" ]] || printf 'B01_CLEANUP_DONE=1\n' >> "$GITHUB_ENV"
    else
      # 10215 na limpeza (o alvo não ficou ativo): o passo always() avisa; limpeza manual pelo Codex.
      status=1
    fi
  fi
  rm -rf -- "$TMP_DIR"
  return "$status"
}

finalize() {
  local status=$? cleanup_status=0 final="INCONCLUSIVE"
  trap - EXIT
  set +e
  cleanup; cleanup_status=$?
  if [[ "$status" == "0" && "$cleanup_status" == "0" && "$RESULT" == "YES" ]]; then
    final="YES"
  else
    status=1
  fi
  [[ "$cleanup_status" == "0" ]] || echo "B01R_CLEANUP_FAILED=1" >&2
  printf 'RECOVERY_CERTIFIED=%s\n' "$final"
  [[ -z "${GITHUB_OUTPUT:-}" ]] || printf 'recovery_certified=%s\n' "$final" >> "$GITHUB_OUTPUT"
  [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf 'RECOVERY_CERTIFIED=%s\n' "$final" >> "$GITHUB_STEP_SUMMARY"
  unset VALUE_A VALUE_B VALUE_C
  exit "$status"
}
trap finalize EXIT

[[ "$WORKER_NAME" == "$PROBE_WORKER" ]] || fail "WORKER_NAME_REFUSED"
[[ -n "$TOKEN" ]] || fail "CLOUDFLARE_SANDBOX_PROBE_TOKEN_MISSING"
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || fail "CLOUDFLARE_SANDBOX_PROBE_TOKEN_MALFORMED"
[[ "$ACCOUNT_ID" == "$ZEVANORY_ACCOUNT_ID" ]] || fail "CLOUDFLARE_ACCOUNT_ID_REFUSED"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "PROBE_ATTEMPTS_INVALID"

VALUE_A="$(openssl rand -hex 32)"; VALUE_B="$(openssl rand -hex 32)"; VALUE_C="$(openssl rand -hex 32)"
HASH_A="$(sha256_value "$VALUE_A")"; HASH_B="$(sha256_value "$VALUE_B")"
[[ "$HASH_A" != "$HASH_B" ]] || fail "PROBE_VALUES_COLLIDED"

# Pré-condição: Worker pré-criado e com versão ativa comprovada. Nunca criar.
INITIAL="$(read_active_version "$TMP_DIR/precheck.json")" || fail "PROBE_WORKER_NOT_PRECREATED_OR_NO_ACCESS"
[[ -n "$INITIAL" ]] || fail "PROBE_WORKER_PRECHECK_STRUCTURE_INVALID"

# Deploy do código: cria e implanta a versão mais recente (remove qualquer 10215 herdado do ensaio anterior).
wr deploy --name "$WORKER_NAME" --config "$CONFIG" > "$TMP_DIR/deploy.log" 2>&1
WORKER_URL="$(grep -Eo "https://${WORKER_NAME}\.[A-Za-z0-9-]+\.workers\.dev" "$TMP_DIR/deploy.log" | tail -1)"
[[ -n "$WORKER_URL" ]] || fail "WORKER_URL_MISSING"

SECRET_WRITTEN=1
[[ -z "${GITHUB_ENV:-}" ]] || printf 'B01_SECRET_WRITTEN=1\n' >> "$GITHUB_ENV"
printf '%s' "$VALUE_A" | wr secret put PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" >/dev/null
VA="$(read_active_version "$TMP_DIR/dep-a.json")"; [[ -n "$VA" ]] || fail "VERSION_A_MISSING"
wait_digest "$HASH_A" A || fail "PROBE_A_NOT_OBSERVED"

printf '%s' "$VALUE_B" | wr secret put PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" >/dev/null
VB="$(read_active_version "$TMP_DIR/dep-b.json")"; [[ -n "$VB" && "$VB" != "$VA" ]] || fail "VERSION_B_MISSING"
wait_digest "$HASH_B" B || fail "PROBE_B_NOT_OBSERVED"
echo "VERSION_A=$VA"
echo "VERSION_B=$VB"

# Retorno automático (o mesmo comando do workflow de produção).
wr rollback "$VA" --name "$WORKER_NAME" --config "$CONFIG" --message "B01-R rollback to A" --yes >/dev/null
[[ "$(read_active_version "$TMP_DIR/dep-rb.json")" == "$VA" ]] || fail "ROLLBACK_NOT_ACTIVE"
wait_digest "$HASH_A" ROLLBACK || fail "ROLLBACK_DIGEST_NOT_A"

# Controle negativo: a condição 10215 tem de estar presente (é o que a recuperação resolve).
if printf '%s' "$VALUE_C" | wr secret put PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" > "$TMP_DIR/put-c.log" 2>&1; then
  fail "CONDITION_10215_NOT_REPRODUCED (secret put aceito depois do rollback; ensaio não representa produção)"
fi
grep -q "10215" "$TMP_DIR/put-c.log" || fail "CONDITION_10215_NOT_REPRODUCED (recusa sem o código 10215)"
echo "CONDITION_10215=observed"

# Recuperação: o MESMO script do modo recover de produção, com o alvo = versão do "token novo".
env RECOVER_WORKER_NAME="$WORKER_NAME" RECOVER_TARGET_VERSION="$VB" RECOVER_EXPECTED_ACTIVE="$VA" \
  CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  NPX_BIN="$NPX_BIN" CURL_BIN="$CURL_BIN" bash "$RECOVER_SCRIPT"
[[ "$(read_active_version "$TMP_DIR/dep-rec.json")" == "$VB" ]] || fail "RECOVERED_VERSION_NOT_ACTIVE"
wait_digest "$HASH_B" RECOVERED || fail "RECOVERED_DIGEST_NOT_B"

RESULT="YES"
exit 0
