#!/usr/bin/env bash
set -Eeuo pipefail

readonly PROBE_WORKER="zevanory-rollback-secret-probe"
readonly NONCE="zevanory-b01-rollback-secret-probe-v1:"
readonly WRANGLER="wrangler@4.143.0"
readonly NPX_BIN="${NPX_BIN:-npx}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
# Determinação do proprietário (21/10 13:06): o ensaio roda na conta CERTA, a Zevanory. Para não dar ao
# token poder sobre produção, o Worker de prova é CRIADO PREVIAMENTE pelo proprietário no painel, e o
# token tem só o papel "Editor" ESCOPADO a esse único Worker (documentação Cloudflare, Workers >
# Authorization: deploy de Worker existente, secret put e rollback exigem só Editor daquele Worker).
# O script nunca cria nem apaga Worker.
readonly ZEVANORY_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb"
readonly CONFIG="sandbox/rollback-secret-probe/wrangler.toml"
readonly WORKER_NAME="${WORKER_NAME:-$PROBE_WORKER}"
readonly TOKEN="${CLOUDFLARE_SANDBOX_PROBE_TOKEN:-}"
readonly ATTEMPTS="${PROBE_ATTEMPTS:-30}"
readonly SLEEP_SECONDS="${PROBE_SLEEP_SECONDS:-2}"

# Contestação Claude (21/10): falha de infraestrutura NÃO pode virar resposta negativa.
# RESULT só vira YES ou NO quando a comparação final rodou com leituras válidas; qualquer outra saída é INCONCLUSIVE.
RESULT="INCONCLUSIVE"
SECRET_WRITTEN=0
TMP_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
TMP_DIR="${TMP_BASE}/b01-rollback-secret-probe-${GITHUB_RUN_ID:-unknown}-$$"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"

validate_worker_name() {
  [[ "$WORKER_NAME" == "$PROBE_WORKER" ]]
}

# Melhoria Sol 031: sucesso do "secret delete" não prova que o segredo deixou de ser servido.
# Certifica-se pela leitura: /probe tem de responder 503 ("probe secret unavailable").
cleanup_certified() {
  [[ -n "${WORKER_URL:-}" ]] || return 1
  local attempt code
  for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    code="$("$CURL_BIN" --silent --show-error --output "$TMP_DIR/probe-cleanup.txt" --write-out '%{http_code}' \
      --connect-timeout 10 --max-time 30 "${WORKER_URL}/probe" || true)"
    [[ "$code" == "503" ]] && { echo "B01_CLEANUP_CERTIFIED=probe_503"; return 0; }
    sleep "$SLEEP_SECONDS"
  done
  echo "B01_CLEANUP_NOT_CERTIFIED last_http=${code:-none}" >&2
  return 1
}

cleanup() {
  local cleanup_status=0
  # Limpeza = neutralizar: apagar o segredo de prova (Editor do Worker basta). O Worker fica, sem segredo,
  # para o proprietário apagar no painel ou reaproveitar.
  if [[ "$SECRET_WRITTEN" == "1" ]]; then
    if ! validate_worker_name; then
      echo "CLEANUP_REFUSED_INVALID_WORKER_NAME" >&2
      return 1
    fi
    if CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
      "$NPX_BIN" --yes "$WRANGLER" secret delete PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" \
      >/dev/null 2>&1 </dev/null && cleanup_certified; then
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
  local final="INCONCLUSIVE"
  trap - EXIT
  set +e
  cleanup
  cleanup_status=$?
  if [[ "$status" == "0" && "$cleanup_status" == "0" && "$RESULT" == "YES" ]]; then
    final="YES"
  elif [[ "$RESULT" == "NO" && "$cleanup_status" == "0" ]]; then
    # Resposta negativa provada (versão A ativa servindo o digest de B); a limpeza não altera a resposta.
    final="NO"
    status=1
  else
    status=1
  fi
  if [[ "$cleanup_status" != "0" ]]; then
    echo "B01_CLEANUP_FAILED=1 (o segredo de prova pode ter ficado; o passo always() tenta de novo)" >&2
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

# Contestação Sol 028.5: só vale o deployment mais recente (deployments[0], documentação Cloudflare),
# com EXATAMENTE uma versão, a 100%, e version_id presente. Qualquer outra forma => sem versão ativa
# comprovada => o script falha => INCONCLUSIVE.
data = json.load(open(sys.argv[1], encoding="utf-8"))
if data.get("success") is False:
    raise SystemExit("DEPLOYMENTS_SUCCESS_FALSE")
deployments = (data.get("result") or {}).get("deployments") or []
if not deployments:
    raise SystemExit("ACTIVE_VERSION_MISSING")
versions = deployments[0].get("versions") or []
if len(versions) != 1:
    raise SystemExit("ACTIVE_VERSION_NOT_SINGLE")
only = versions[0]
if only.get("percentage") != 100 or isinstance(only.get("percentage"), bool):
    raise SystemExit("ACTIVE_VERSION_NOT_100")
value = only.get("version_id")
if not isinstance(value, str) or not value:
    raise SystemExit("ACTIVE_VERSION_ID_MISSING")
print(value)
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
[[ "$ACCOUNT_ID" == "$ZEVANORY_ACCOUNT_ID" ]] || fail "CLOUDFLARE_ACCOUNT_ID_REFUSED"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || fail "PROBE_ATTEMPTS_INVALID"

VALUE_A="$(openssl rand -hex 32)"
VALUE_B="$(openssl rand -hex 32)"
[[ "$VALUE_A" != "$VALUE_B" ]] || fail "PROBE_VALUES_COLLIDED"
HASH_A="$(sha256_value "$VALUE_A")"
HASH_B="$(sha256_value "$VALUE_B")"

# Pré-condição: o Worker de prova já existe (criado pelo proprietário). Nunca criar.
precheck="$("$CURL_BIN" --silent --show-error --output "$TMP_DIR/precheck.json" --write-out '%{http_code}' \
  --connect-timeout 10 --max-time 30 --header "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments")"
[[ "$precheck" == "200" ]] || fail "PROBE_WORKER_NOT_PRECREATED_OR_NO_ACCESS_HTTP_${precheck}"
# Melhoria Sol 031: HTTP 200 não basta. Uma lista de deployments vazia ou malformada também passaria.
# Exige-se a mesma estrutura estrita da versão ativa (deployments[0], uma versão a 100%) ANTES de qualquer escrita.
INITIAL_VERSION="$(read_active_version "$TMP_DIR/precheck-structure.json")" || fail "PROBE_WORKER_PRECHECK_STRUCTURE_INVALID"
[[ -n "$INITIAL_VERSION" ]] || fail "PROBE_WORKER_PRECHECK_STRUCTURE_INVALID"

CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  "$NPX_BIN" --yes "$WRANGLER" deploy --name "$WORKER_NAME" --config "$CONFIG" \
  > "$TMP_DIR/deploy.log" 2>&1
WORKER_URL="$(grep -Eo "https://${WORKER_NAME}\.[A-Za-z0-9-]+\.workers\.dev" "$TMP_DIR/deploy.log" | tail -1)"
[[ -n "$WORKER_URL" ]] || fail "WORKER_URL_MISSING"

SECRET_WRITTEN=1
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
  if candidate="$(read_probe "$TMP_DIR/probe-a.txt")"; then
    observed_a="$candidate"
    [[ "$observed_a" == "$HASH_A" ]] && break
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
if [[ "$ACTIVE_VERSION" == "$VERSION_A" && "$observed_a" == "$HASH_B" ]]; then
  RESULT="NO"
fi
exit 1
