#!/usr/bin/env bash
set -Eeuo pipefail

readonly WORKER_NAME="zevanory-rollback-secret-probe"
readonly CONFIG="sandbox/rollback-secret-probe/wrangler.toml"
# Run 39639303995 (21/10): a Cloudflare respondeu "Invalid format for Authorization header" (6111),
# assinatura de espaço ou quebra de linha colados no segredo, como no #850/#851. O valor é saneado antes do uso.
readonly TOKEN="$(printf '%s' "${CLOUDFLARE_SANDBOX_PROBE_TOKEN:-}" | tr -d '[:space:]')"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

[[ "$WORKER_NAME" == "zevanory-rollback-secret-probe" ]] || {
  echo "CLEANUP_REFUSED_INVALID_WORKER_NAME" >&2
  exit 1
}
[[ -n "$TOKEN" ]] || {
  echo "CLOUDFLARE_SANDBOX_PROBE_TOKEN_MISSING" >&2
  exit 1
}
[[ "$ACCOUNT_ID" == "1b26415802588185a86c1d4d3ebf5bdb" ]] || {
  echo "CLOUDFLARE_ACCOUNT_ID_REFUSED" >&2
  exit 1
}

# Nada a limpar se o ensaio parou antes de gravar o segredo de prova (ex.: run 39639303995).
if [[ "${B01_SECRET_WRITTEN:-}" != "1" ]]; then
  echo "B01_CLEANUP_NOT_NEEDED=no_secret_written"
  exit 0
fi

if [[ "${B01_CLEANUP_DONE:-}" == "1" ]]; then
  echo "B01_CLEANUP_ALREADY_DONE=YES"
  exit 0
fi

# Contestação Sol 051-F1: a saída do wrangler nunca vai para o log; só os códigos numéricos.
CLEAN_LOG="$(mktemp)"
trap 'rm -f "$CLEAN_LOG"' EXIT
delete_secret() {
  if CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
    npx --yes wrangler@4.143.0 secret delete PROBE_SECRET --name "$WORKER_NAME" --config "$CONFIG" \
    > "$CLEAN_LOG" 2>&1 </dev/null; then
    return 0
  fi
  echo "B01_CLEANUP_DELETE_FAILED codes=$(grep -oE '\[code: [0-9]{1,6}\]' "$CLEAN_LOG" | grep -oE '[0-9]+' | sort -u | paste -sd, - || true)"
  return 1
}

if ! delete_secret; then
  # Ensaio 3 (run 39643799156): depois de um rollback, secret delete é recusado (Cloudflare 10215) até a
  # versão mais recente estar implantada. Um deploy do código do Worker de prova cria e implanta a mais
  # recente (o segredo continua vinculado) e libera a remoção. Só no Worker de prova; nunca cria Worker.
  echo "B01_CLEANUP_RETRY_AFTER_DEPLOY=1 (possível 10215)"
  CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
    npx --yes wrangler@4.143.0 deploy --name "$WORKER_NAME" --config "$CONFIG" > "$CLEAN_LOG" 2>&1 </dev/null
  delete_secret
fi
echo "B01_CLEANUP_DONE=YES"
