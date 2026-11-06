#!/usr/bin/env bash
# ZEVANORY | Recalculo INDEPENDENTE (OpenSSL) dos vetores da x-signature Mercado Pago (Roteiro v4.4, seção 7).
# Não usa Node nem o código do Worker: só jq + openssl + coreutils, para o auditor reproduzir sem confiar no repositório.
# Para cada vetor de data/test-vectors/mercadopago-signature-v1.json:
#   1. reconstrói o manifesto pelo modelo oficial "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" a partir da
#      query data.id, do header x-request-id e do ts extraído pela especificação (parte ausente é removida) e compara
#      com "manifest";
#   2. expected_v1        = printf '%s' "$manifest" | openssl dgst -sha256 -hmac "$secret"
#   3. sha256_manifest    = printf '%s' "$manifest" | openssl dgst -sha256
#   4. sha256_expected_v1 = printf '%s' "$expected_v1" | openssl dgst -sha256
#   5. presented_v1 = HMAC(signed_manifest) quando signed_manifest existe; no vetor de 1 caractere alterado, confere
#      que difere de expected_v1 em exatamente 1 posição;
#   6. hmac_matches == (presented_v1 minúsculo == expected_v1) e, havendo x-signature, o header carrega presented_v1.
# Sai != 0 em QUALQUER divergência, em JSON ilegível, segredo não marcado como FICTÍCIO ou lista de vetores vazia.
# Uso: scripts/ci/mp_vectors_openssl.sh [arquivo.json]       (padrão: data/test-vectors/mercadopago-signature-v1.json)
#      scripts/ci/mp_vectors_openssl.sh --self-test          (adultera cópias temporárias e exige que cada uma falhe)
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT="$ROOT/data/test-vectors/mercadopago-signature-v1.json"
for tool in jq openssl awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "TOOL_MISSING: $tool"; exit 2; }
done

hmac_hex() { printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" | awk '{print $NF}'; }
sha_hex() { printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'; }

verify_file() {
  local f="$1" fails=0 n i
  jq -e '.schema == "zevanory.test-vectors.mercadopago-signature.v1"' "$f" >/dev/null 2>&1 || { echo "MP_VECTORS_FAIL schema/JSON inválido: $f"; return 1; }
  local secret; secret="$(jq -r '.secret' "$f")"
  case "$secret" in
    *FICTITIOUS*) ;;
    *) echo "MP_VECTORS_FAIL segredo não marcado como FICTITIOUS"; return 1 ;;
  esac
  jq -e '.secret_is_fictitious == true' "$f" >/dev/null || { echo "MP_VECTORS_FAIL secret_is_fictitious != true"; return 1; }
  n="$(jq '.vectors | length' "$f")"
  [ "$n" -ge 1 ] || { echo "MP_VECTORS_FAIL nenhum vetor"; return 1; }
  for ((i = 0; i < n; i++)); do
    local v id did rid has_rid ts manifest want got sm pv hm xsig has_xsig derivation bad=0
    v="$(jq -c ".vectors[$i]" "$f")"
    id="$(jq -r '.id' <<<"$v")"
    did="$(jq -r '.request.query["data.id"] // ""' <<<"$v")"
    has_rid="$(jq -r '.request.headers | has("x-request-id")' <<<"$v")"
    rid="$(jq -r '.request.headers["x-request-id"] // ""' <<<"$v")"
    ts="$(jq -r '.parsed_per_spec.ts // ""' <<<"$v")"
    manifest="$(jq -r '.manifest' <<<"$v")"
    # 1. manifesto oficial (pares ausentes removidos; data.id em minúsculas)
    want=""
    [ -n "$did" ] && want+="id:$(printf '%s' "$did" | tr 'A-Z' 'a-z');"
    [ "$has_rid" = true ] && [ -n "$rid" ] && want+="request-id:$rid;"
    [ -n "$ts" ] && want+="ts:$ts;"
    [ "$want" = "$manifest" ] || { echo "MP_VECTORS_MISMATCH $id manifest json=$manifest openssl_model=$want"; bad=1; }
    # 2-4. HMAC e SHA-256
    got="$(hmac_hex "$secret" "$manifest")"
    [ "$got" = "$(jq -r '.expected_v1' <<<"$v")" ] || { echo "MP_VECTORS_MISMATCH $id expected_v1 openssl=$got"; bad=1; }
    [ "$(sha_hex "$manifest")" = "$(jq -r '.sha256_manifest' <<<"$v")" ] || { echo "MP_VECTORS_MISMATCH $id sha256_manifest"; bad=1; }
    [ "$(sha_hex "$got")" = "$(jq -r '.sha256_expected_v1' <<<"$v")" ] || { echo "MP_VECTORS_MISMATCH $id sha256_expected_v1"; bad=1; }
    # 5. origem do v1 apresentado
    sm="$(jq -r '.signed_manifest // ""' <<<"$v")"
    pv="$(jq -r '.presented_v1 // ""' <<<"$v")"
    derivation="$(jq -r '.presented_v1_derivation' <<<"$v")"
    if [ "$(jq -r '.signed_manifest == null' <<<"$v")" = false ]; then
      [ "$(hmac_hex "$secret" "$sm")" = "$(printf '%s' "$pv" | tr 'A-F' 'a-f')" ] || { echo "MP_VECTORS_MISMATCH $id presented_v1 != HMAC(signed_manifest)"; bad=1; }
    elif [ -n "$pv" ]; then
      case "$derivation" in
        *"exactly 1 char differs"*)
          local d=0 k
          [ "${#pv}" = "${#got}" ] || { echo "MP_VECTORS_MISMATCH $id presented_v1 com tamanho diferente"; bad=1; }
          for ((k = 0; k < ${#got}; k++)); do [ "${pv:k:1}" = "${got:k:1}" ] || d=$((d + 1)); done
          [ "$d" = 1 ] || { echo "MP_VECTORS_MISMATCH $id presented_v1 difere em $d caracteres (esperado 1)"; bad=1; } ;;
        *) echo "MP_VECTORS_MISMATCH $id presented_v1 sem signed_manifest nem derivação verificável"; bad=1 ;;
      esac
    fi
    # 6. hmac_matches e presença do v1 no header
    hm="false"; [ -n "$pv" ] && [ "$(printf '%s' "$pv" | tr 'A-F' 'a-f')" = "$got" ] && hm="true"
    [ "$hm" = "$(jq -r '.hmac_matches' <<<"$v")" ] || { echo "MP_VECTORS_MISMATCH $id hmac_matches openssl=$hm"; bad=1; }
    has_xsig="$(jq -r '.request.headers | has("x-signature")' <<<"$v")"
    if [ "$has_xsig" = true ]; then
      xsig="$(jq -r '.request.headers["x-signature"]' <<<"$v")"
      case "$xsig" in *"$pv"*) ;; *) echo "MP_VECTORS_MISMATCH $id x-signature não contém presented_v1"; bad=1 ;; esac
    fi
    case "$(jq -r '.expected' <<<"$v")" in accept|refuse) ;; *) echo "MP_VECTORS_MISMATCH $id expected inválido"; bad=1 ;; esac
    if [ "$bad" = 0 ]; then
      echo "MP_VECTOR $id OK expected=$(jq -r '.expected' <<<"$v") hmac_matches=$hm v1=${got:0:16}..."
    else
      fails=$((fails + 1))
    fi
  done
  echo "MP_VECTORS_OPENSSL total=$n ok=$((n - fails)) mismatch=$fails openssl=\"$(openssl version)\""
  [ "$fails" = 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  # Meta-teste: cada adulteração de uma cópia temporária TEM de fazer o verificador sair != 0.
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  verify_file "$DEFAULT" >/dev/null || { echo "MP_VECTORS_SELF_TEST baseline FAIL"; exit 1; }
  # flip: troca o 1º caractere hexadecimal por outro garantidamente diferente (nunca no-op).
  flip='def flip: ((.[0:1] | if . == "0" then "1" else "0" end) + .[1:]);'
  declare -a cases=(
    'expected_v1|.vectors[0].expected_v1 |= flip'
    'manifest|.vectors[2].manifest |= sub("123456780"; "123456789")'
    'sha256_manifest|.vectors[3].sha256_manifest |= flip'
    'sha256_expected_v1|.vectors[4].sha256_expected_v1 |= flip'
    'presented_v1|.vectors[6].presented_v1 |= flip'
    'one_char|.vectors[1].presented_v1 |= flip'
    'hmac_matches|.vectors[0].hmac_matches = false'
    'secret|.secret = "real-looking-secret"'
    'secret_hmac|.secret = "FICTITIOUS-TEST-SECRET-do-not-usf"'
  )
  rc_all=0
  for c in "${cases[@]}"; do
    name="${c%%|*}"; filter="${c#*|}"
    jq "$flip $filter" "$DEFAULT" > "$tmp/$name.json"
    [ "$(jq -cS . "$DEFAULT")" = "$(jq -cS . "$tmp/$name.json")" ] && { echo "MP_VECTORS_SELF_TEST $name FAIL (adulteração não alterou o arquivo)"; rc_all=1; continue; }
    if verify_file "$tmp/$name.json" >/dev/null 2>&1; then
      echo "MP_VECTORS_SELF_TEST $name FAIL (adulteração não detectada)"; rc_all=1
    else
      echo "MP_VECTORS_SELF_TEST $name PASS (detectada)"
    fi
  done
  exit "$rc_all"
fi

verify_file "${1:-$DEFAULT}"
