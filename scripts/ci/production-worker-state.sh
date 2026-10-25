#!/usr/bin/env bash
# ZEVANORY | Coleta SOMENTE LEITURA do estado do Worker de produção `zevanory` para production-secret-names.mjs
# (production-test-secret-readback.yml e production-test-secret-cleanup.yml). Uso: source este arquivo e chame
#   zev_fetch_state DIR
# DIR recebe secrets.json (wrangler secret list: só [{name,type}]), settings.json, deployments.json, version.json
# (versão efetiva única a 100%) e release.json (GET público https://zevanory.api.br/api/release; {} se indisponível).
# Só GET; nada é gravado no Worker. Exige CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID no ambiente;
# CLOUDFLARE_TOKEN_SOURCE (opcional) diz, só pelo NOME, de qual segredo o token veio.
#
# Falha ruidosa e segura (run 40142599036 saiu com código 1 sem nenhuma linha): cada coleta que falha emite
#   ::error title=WORKER_STATE::<etapa> failed (http=<código>)
# com o status HTTP e errors[].code/message da Cloudflare (redigidos), nunca o corpo, o token ou um valor. O stderr do
# wrangler vai para arquivo e só as últimas linhas, redigidas, são impressas. Depois da primeira falha roda um
# diagnóstico só leitura (zev_diagnose): token ativo?, a conta lista scripts?, o zevanory aparece?, settings x
# script-settings, versions. Retorna != 0 se qualquer leitura da Cloudflare falhar ou se não houver versão única a 100%.

ZEV_CF_API="https://api.cloudflare.com/client/v4"

zev_note() { echo "WORKER_STATE $*"; }

zev_whoami() {
  zev_note "credential_source=${CLOUDFLARE_TOKEN_SOURCE:-desconhecido} token_present=$([ -n "${CLOUDFLARE_API_TOKEN:-}" ] && echo yes || echo no) account=${CLOUDFLARE_ACCOUNT_ID:-ausente}"
}

# zev_http_get ETAPA URL ARQUIVO [auth|public] -> 0 só com HTTP 200; senão ::error com o código e os erros da Cloudflare.
zev_http_get() {
  local step="$1" url="$2" out="$3" mode="${4:-auth}" code="" rc=0
  if [ "$mode" = "auth" ]; then
    code="$(curl -sS --connect-timeout 10 --max-time 30 -o "$out" -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$url" 2>"$out.curlerr")" || rc=$?
  else
    code="$(curl -sS --connect-timeout 10 --max-time 20 -o "$out" -w '%{http_code}' "$url" 2>"$out.curlerr")" || rc=$?
  fi
  if [ "$rc" != 0 ] || [ "$code" != "200" ]; then
    echo "::error title=WORKER_STATE::$step failed (http=${code:-000} curl_exit=$rc)"
    node scripts/ci/production-secret-names.mjs redact --file "$out.curlerr" --lines 3 | sed 's/^/WORKER_STATE curl: /'
    [ -s "$out" ] && node scripts/ci/production-secret-names.mjs cf-errors --file "$out" | sed "s/^/WORKER_STATE $step: /"
    rm -f "$out.curlerr"
    return 1
  fi
  rm -f "$out.curlerr"
  return 0
}

zev_cf_get() { zev_http_get "$1" "$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/$1" "$2"; }

# Diagnóstico das causas prováveis; só GET, só códigos HTTP e códigos de erro da Cloudflare.
zev_diagnose() {
  local d="$1/diagnose" code
  mkdir -p "$d"
  zev_whoami
  for probe in "token_verify_account|$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" "token_verify_user|$ZEV_CF_API/user/tokens/verify" \
               "scripts_list|$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" "settings|$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/settings" \
               "script_settings|$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/script-settings" \
               "deployments|$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/deployments" \
               "versions|$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/versions?per_page=1"; do
    local name="${probe%%|*}" url="${probe#*|}"
    code="$(curl -sS --connect-timeout 10 --max-time 20 -o "$d/$name.json" -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$url" 2>/dev/null)" || true
    echo "WORKER_STATE diagnose $name http=${code:-000}"
    [ -s "$d/$name.json" ] && node scripts/ci/production-secret-names.mjs cf-errors --file "$d/$name.json" | sed "s/^/WORKER_STATE diagnose $name: /"
    if [ "$name" = "scripts_list" ] && [ -s "$d/$name.json" ]; then
      node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ids=(d.result||[]).map(s=>s.id);console.log("WORKER_STATE diagnose scripts_list count="+ids.length+" zevanory_listed="+ids.includes("zevanory"))}catch{console.log("WORKER_STATE diagnose scripts_list ilegível")}' "$d/$name.json"
    fi
  done
  rm -rf "$d"
}

zev_fetch_state() {
  local o="$1" vid="" rc=0
  mkdir -p "$o" || return 1
  zev_whoami
  npx --yes wrangler@4.143.0 secret list --name zevanory --format json > "$o/secrets.json" 2> "$o/wrangler.err" || rc=$?
  if [ "$rc" != 0 ] || ! node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(a))process.exit(1)' "$o/secrets.json" 2>/dev/null; then
    echo "::error title=WORKER_STATE::wrangler secret list failed (exit=$rc)"
    node scripts/ci/production-secret-names.mjs redact --file "$o/wrangler.err" --lines 15 | sed 's/^/WORKER_STATE wrangler: /'
    rm -f "$o/wrangler.err"; zev_diagnose "$o"; return 1
  fi
  rm -f "$o/wrangler.err"
  zev_cf_get settings "$o/settings.json" || { zev_diagnose "$o"; return 1; }
  zev_cf_get deployments "$o/deployments.json" || { zev_diagnose "$o"; return 1; }
  vid="$(node scripts/ci/production-secret-names.mjs version-id --deployments "$o/deployments.json")" || rc=$?
  if [ "$rc" != 0 ] || [ -z "$vid" ]; then
    # Saída do version-id é um código de validação (INPUT_INVALID <motivo> / NO_SINGLE_VERSION), nunca um valor.
    echo "::error title=WORKER_STATE::version-id failed (exit=$rc) $(printf '%s' "$vid" | tr '\n' ' ' | cut -c1-200)"
    node scripts/ci/production-secret-names.mjs cf-errors --file "$o/deployments.json" | sed 's/^/WORKER_STATE deployments: /'
    return 1
  fi
  zev_note "effective_version=$vid"
  zev_cf_get "versions/$vid" "$o/version.json" || { zev_diagnose "$o"; return 1; }
  if ! zev_http_get release https://zevanory.api.br/api/release "$o/release.json" public; then
    echo "WORKER_STATE release indisponível (não fatal: commit_sha fica indisponível e o digest o registra assim)"
    echo '{}' > "$o/release.json"
  fi
  return 0
}

# Histórico de versões e deployments (premissas do Sol); sanitizado por production-secret-names.mjs history.
# zev_fetch_history DIR SAIDA.json [N] -> versions?per_page=N (até 50) + GET de cada versão + deployments.
zev_fetch_history() {
  local o="$1" out="$2" n="${3:-50}" ids details=()
  mkdir -p "$o/history" || return 1
  zev_http_get versions_list "$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/versions?page=1&per_page=$n" "$o/history/list.json" || return 1
  zev_cf_get deployments "$o/history/deployments.json" || return 1
  ids="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const it=(d.result&&(d.result.items||d.result))||[];for(const v of it.slice(0,Number(process.argv[2])))if(/^[0-9a-f-]{36}$/.test(String(v.id||"")))console.log(v.id)' "$o/history/list.json" "$n")" || return 1
  for id in $ids; do
    zev_http_get "versions/$id" "$ZEV_CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/zevanory/versions/$id" "$o/history/$id.json" && details+=(--detail "$o/history/$id.json")
  done
  local rc=0
  node scripts/ci/production-secret-names.mjs history --versions "$o/history/list.json" "${details[@]}" --deployments "$o/history/deployments.json" --out "$out" || rc=$?
  rm -rf "$o/history"
  return $rc
}
