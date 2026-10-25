#!/usr/bin/env bash
# R9 (Sol 164 §4): presença dos dois nomes da credencial de operador num Environment do GitHub e igualdade dos valores
# durante a transição. Imprime SÓ present|absent e true|false|n/a; nunca valor, tamanho ou hash.
# Entrada: R9_NEW (secrets.ZEVANORY_OPERATOR_TOKEN), R9_LEGACY (secrets.CERTIFICATION_E2E_TOKEN), REQUIRE_PRIMARY,
#          OPERATOR_TOKEN_MIGRATION_UNTIL (vars.OPERATOR_TOKEN_MIGRATION_UNTIL, não secreta, AAAA-MM-DD).
# Janela de migração (Sol 233): o valor NOVO não é cópia do antigo; valores diferentes só são aceitos com a janela ABERTA:
# data válida, não vencida (dia UTC de hoje <= data) e <= MIGRATION_CODE_CEILING (o mesmo teto em código do Worker,
# worker/operator-credential.mjs). Sem a flag, malformada, vencida ou acima do teto: igualdade exigida como antes.
# Uso: operator-token-github-presence.sh <environment-label>
set -euo pipefail
set +x
label="${1:?environment label}"
case "$label" in *[!a-z0-9-]*) echo "invalid label"; exit 2 ;; esac
tag="$(printf '%s' "$label" | tr 'a-z-' 'A-Z_')"
MIGRATION_CODE_CEILING="2026-12-31"
mig="${OPERATOR_TOKEN_MIGRATION_UNTIL:-}"
today="$(date -u +%F)"
if [ -z "$mig" ]; then window=absent
elif [[ "$mig" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [ "$(date -u -d "$mig" +%F 2>/dev/null || true)" = "$mig" ]; then
  if [[ "$mig" > "$MIGRATION_CODE_CEILING" ]]; then window=beyond_code_ceiling
  elif [[ "$today" > "$mig" ]]; then window=expired
  else window=open; fi
else window=invalid; fi
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
echo "GITHUB_OPERATOR_TOKEN_MIGRATION=$window"
if [ "$eq" = false ] && [ "$window" = open ]; then
  echo "::notice title=R9_OPERATOR_TOKEN_MIGRATION::$label: valores diferentes aceitos dentro da janela de migração (até $mig)"
elif [ "$eq" = false ]; then
  # Durante a transição a produção ainda pode cair para o nome antigo no Worker: valores diferentes quebrariam os
  # consumidores que já mandam o nome novo. Depois da retirada da queda, a igualdade deixa de ser exigida.
  echo "::error title=R9_OPERATOR_TOKEN_MISMATCH::$label: ZEVANORY_OPERATOR_TOKEN difere de CERTIFICATION_E2E_TOKEN fora da janela de migração ($window)"
  exit 1
fi
if [ "${REQUIRE_PRIMARY:-false}" = "true" ] && [ "$n" != present ]; then
  echo "::error title=R9_OPERATOR_TOKEN_NOT_PRIMARY::$label: ZEVANORY_OPERATOR_TOKEN ausente"
  exit 1
fi
echo "R9_GITHUB_OPERATOR_TOKEN_${tag}=PASS"
