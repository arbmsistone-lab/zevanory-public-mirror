#!/usr/bin/env bash
# ZEVANORY | Coleta SOMENTE LEITURA do estado do Worker de produção `zevanory` para production-secret-names.mjs
# (production-test-secret-readback.yml e production-test-secret-cleanup.yml). Uso: source este arquivo e chame
#   zev_fetch_state DIR
# DIR recebe secrets.json (wrangler secret list: só [{name,type}]), settings.json, deployments.json, version.json
# (versão efetiva única a 100%) e release.json (GET público https://zevanory.api.br/api/release; {} se indisponível).
# Só GET; nada é gravado no Worker. Exige CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID no ambiente.
# Retorna != 0 se qualquer leitura da Cloudflare falhar ou se não houver uma versão única a 100%.

zev_cf_get() {
  curl -fsS --connect-timeout 10 --max-time 30 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/$1" -o "$2"
}

zev_fetch_state() {
  local o="$1" vid
  mkdir -p "$o" || return 1
  npx --yes wrangler@4.143.0 secret list --name zevanory --format json > "$o/secrets.json" || return 1
  zev_cf_get settings "$o/settings.json" || return 1
  zev_cf_get deployments "$o/deployments.json" || return 1
  vid="$(node scripts/ci/production-secret-names.mjs version-id --deployments "$o/deployments.json")" || return 1
  [ -n "$vid" ] || { echo "::error title=WORKER_STATE::sem versão única a 100% (rollout gradual?)"; return 1; }
  zev_cf_get "versions/$vid" "$o/version.json" || return 1
  curl -fsS --connect-timeout 10 --max-time 20 https://zevanory.api.br/api/release -o "$o/release.json" || echo '{}' > "$o/release.json"
}
