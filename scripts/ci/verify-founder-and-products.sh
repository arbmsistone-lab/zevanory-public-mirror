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
redirect_headers="$(mktemp)"
trap 'rm -f "$asset_headers" "$redirect_headers"' EXIT
redirect_code="$(curl --silent --show-error --max-time 20 -o /dev/null -D "$redirect_headers" -w '%{http_code}' https://zevanory.api.br/quem-criou/)"
test "$redirect_code" = 308
grep -Eiq '^location:[[:space:]]*https://vendas\.zevanory\.api\.br/quem-criou/?\r?$' "$redirect_headers"
final_code="$(curl --silent --show-error --location --max-redirs 2 --max-time 20 -o /dev/null -w '%{http_code}' https://zevanory.api.br/quem-criou/)"
test "$final_code" = 200
echo "ORDER40_APEX_REDIRECT=308 FINAL_HTTP=200"
