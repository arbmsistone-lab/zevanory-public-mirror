#!/usr/bin/env bash
set -euo pipefail
SALES=https://vendas.zevanory.api.br
for path in /solucoes/ /quem-criou/ /ia-na-pratica/ /vendas-na-pratica/ /lucro-e-caixa/ /combo-ia-vendas/ /negocio-completo/; do
  code="$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' "$SALES$path")"
  printf 'ORDER40_SALES_HTTP path=%s code=%s\n' "$path" "$code"
  test "$code" = 200
done
asset_headers="$(mktemp)"
trap 'rm -f "$asset_headers"' EXIT
asset_code="$(curl --silent --show-error --max-time 20 -o /dev/null -D "$asset_headers" -w '%{http_code}' "$SALES/assets/renan-bitu.webp")"
test "$asset_code" = 200
grep -Eiq '^content-type:[[:space:]]*image/webp([[:space:]]|;|$)' "$asset_headers"
echo "ORDER40_PORTRAIT_HTTP=200 CONTENT_TYPE=image/webp"
