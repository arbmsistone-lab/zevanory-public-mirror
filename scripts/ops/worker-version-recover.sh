#!/usr/bin/env bash
# Recuperação depois de um retorno automático (Cloudflare 10215) — contestação Sol, Ordem 046 R2.
#
# Situação: a rotação gravou o token novo (versão N), falhou depois e o workflow voltou para a versão
# anterior (P). O token antigo morre 12 h depois da renovação no Mercado Pago. Um novo "secret put" é
# recusado (10215) porque a versão mais recente (N) não está implantada. A recuperação é implantar N.
#
# Este é o ÚNICO script de recuperação: o mesmo arquivo é ensaiado no Worker descartável
# (sandbox/rollback-secret-probe/run-recovery-probe.sh) e usado pelo modo "recover" do workflow de produção.
#
# Regras (falha fechada; nenhuma escrita antes de todas valerem):
#   1. Worker só da lista permitida; conta só a Zevanory.
#   2. TARGET_VERSION tem de ser a versão MAIS RECENTE (maior "number", inteiro, único).
#   3. A versão ativa (deployments[0], uma versão a 100%) tem de ser EXATAMENTE o ROLLBACK_POINT do incidente
#      (RECOVER_EXPECTED_ACTIVE, impresso pelo run de rotação que voltou). Contestação bloqueante Sol 047:
#      sem esse vínculo, a recuperação poderia promover uma versão sobre um estado diferente do incidente.
#      O alvo nunca é igual ao ROLLBACK_POINT.
#   4. Implanta o alvo a 100% e certifica por leitura: a versão ativa passa a ser exatamente o alvo.
# Nunca lê, imprime ou grava valor de segredo.
set -Eeuo pipefail

readonly WRANGLER="wrangler@4.143.0"
readonly NPX_BIN="${NPX_BIN:-npx}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly ZEVANORY_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb"
readonly WORKER_NAME="${RECOVER_WORKER_NAME:-}"
readonly TARGET="${RECOVER_TARGET_VERSION:-}"
readonly EXPECTED_ACTIVE="${RECOVER_EXPECTED_ACTIVE:-}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
TOKEN="$(printf '%s' "${CLOUDFLARE_API_TOKEN:-}" | tr -d '[:space:]')"
readonly TOKEN

fail() { echo "::error title=$1::${2:-}" >&2; exit 1; }

case "$WORKER_NAME" in
  zevanory|zevanory-rollback-secret-probe) ;;
  *) fail RECOVER_WORKER_REFUSED "name=${WORKER_NAME:-empty}" ;;
esac
[[ "$ACCOUNT_ID" == "$ZEVANORY_ACCOUNT_ID" ]] || fail RECOVER_ACCOUNT_REFUSED
[[ -n "$TOKEN" ]] || fail RECOVER_TOKEN_MISSING
readonly UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$TARGET" =~ $UUID_RE ]] || fail RECOVER_TARGET_INVALID
[[ "$EXPECTED_ACTIVE" =~ $UUID_RE ]] || fail RECOVER_ROLLBACK_POINT_INVALID "RECOVER_EXPECTED_ACTIVE ausente ou inválido"
[[ "$EXPECTED_ACTIVE" != "$TARGET" ]] || fail RECOVER_TARGET_EQUALS_ROLLBACK_POINT

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
API="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}"

cf_get() {
  local path="$1" out="$2" code
  code="$("$CURL_BIN" --silent --show-error --output "$out" --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 --header "Authorization: Bearer $TOKEN" "${API}/${path}")"
  [[ "$code" == "200" ]] || fail "RECOVER_${path^^}_HTTP" "http=$code"
}

active_version() {
  cf_get deployments "$TMP/deployments.json"
  jq -r '(.result.deployments // []) as $d
    | if ($d|length)==0 then empty
      else ($d[0].versions // []) as $v
        | if ($v|length)!=1 or ($v[0].percentage|type)!="number" or $v[0].percentage!=100 then empty
          else ($v[0].version_id // empty) end
      end' "$TMP/deployments.json"
}

latest_version() {
  cf_get versions "$TMP/versions.json"
  jq -r '(.result.items // []) as $v
    | if ($v|length)==0 or ([$v[]|.number|(type=="number" and . >= 0 and . == floor)]|all|not) then empty
      else ($v|max_by(.number)) as $m
        | if ([$v[]|select(.number==$m.number)]|length)!=1 then empty else $m.id end
      end // empty' "$TMP/versions.json"
}

before="$(active_version)"
[[ -n "$before" ]] || fail RECOVER_ACTIVE_NOT_RESOLVABLE
latest="$(latest_version)"
[[ -n "$latest" ]] || fail RECOVER_LATEST_NOT_RESOLVABLE
echo "RECOVER_ACTIVE_BEFORE=$before"
echo "RECOVER_LATEST=$latest"
[[ "$latest" == "$TARGET" ]] || fail RECOVER_TARGET_NOT_LATEST "target=$TARGET latest=$latest — outra versão foi criada depois; parar e decidir com o proprietário"
[[ "$before" != "$TARGET" ]] || fail RECOVER_NOTHING_TO_DO "o alvo já está ativo"
[[ "$before" == "$EXPECTED_ACTIVE" ]] || fail RECOVER_ACTIVE_NOT_ROLLBACK_POINT "active=$before rollback_point=$EXPECTED_ACTIVE — o estado mudou desde o incidente; parar e decidir com o proprietário"

CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  "$NPX_BIN" --yes "$WRANGLER" versions deploy "${TARGET}@100" --name "$WORKER_NAME" \
  --message "B01 recovery: deploy latest version $TARGET (10215)" --yes </dev/null \
  || echo "RECOVER_DEPLOY_COMMAND_FAILED=1 (a leitura abaixo decide)"

after="$(active_version)"
if [[ "$after" != "$TARGET" ]]; then
  fail RECOVER_READBACK_FAIL "active=${after:-none} expected=$TARGET"
fi
echo "RECOVER_READBACK=PASS active=$after"
