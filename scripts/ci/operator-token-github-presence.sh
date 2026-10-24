#!/usr/bin/env bash
# R9 (Sol 164 §4): presença dos dois nomes da credencial de operador num Environment do GitHub e igualdade dos valores
# durante a transição. Imprime SÓ present|absent e true|false|n/a; nunca valor, tamanho ou hash.
# Entrada: R9_NEW (secrets.ZEVANORY_OPERATOR_TOKEN), R9_LEGACY (secrets.CERTIFICATION_E2E_TOKEN), REQUIRE_PRIMARY.
# Uso: operator-token-github-presence.sh <environment-label>
set -euo pipefail
set +x
label="${1:?environment label}"
case "$label" in *[!a-z0-9-]*) echo "invalid label"; exit 2 ;; esac
tag="$(printf '%s' "$label" | tr 'a-z-' 'A-Z_')"
new="${R9_NEW:-}"
legacy="${R9_LEGACY:-}"
unset R9_NEW R9_LEGACY
[ -n "$new" ] && n=present || n=absent
[ -n "$legacy" ] && l=present || l=absent
if [ "$n" = present ] && [ "$l" = present ]; then
  if [ "$new" = "$legacy" ]; then eq=true; else eq=false; fi
else
  eq=n/a
fi
new=""; legacy=""
echo "GITHUB_${tag}_ZEVANORY_OPERATOR_TOKEN=$n"
echo "GITHUB_${tag}_CERTIFICATION_E2E_TOKEN=$l"
echo "GITHUB_${tag}_OPERATOR_TOKEN_VALUES_EQUAL=$eq"
if [ "$eq" = false ]; then
  # Durante a transição a produção ainda pode cair para o nome antigo no Worker: valores diferentes quebrariam os
  # consumidores que já mandam o nome novo. Depois da retirada da queda, a igualdade deixa de ser exigida.
  echo "::error title=R9_OPERATOR_TOKEN_MISMATCH::$label: ZEVANORY_OPERATOR_TOKEN difere de CERTIFICATION_E2E_TOKEN durante a transição"
  exit 1
fi
if [ "${REQUIRE_PRIMARY:-false}" = "true" ] && [ "$n" != present ]; then
  echo "::error title=R9_OPERATOR_TOKEN_NOT_PRIMARY::$label: ZEVANORY_OPERATOR_TOKEN ausente"
  exit 1
fi
echo "R9_GITHUB_OPERATOR_TOKEN_${tag}=PASS"
