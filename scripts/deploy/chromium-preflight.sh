#!/usr/bin/env bash
# Chromium do smoke pós-deploy (central-production-deploy.yml): instala e ABRE o navegador ANTES da publicação.
# Uso: chromium-preflight.sh <diretório fora da árvore do repositório>
# Saída: CHROMIUM_PREFLIGHT=PASS <versão> e código 0; qualquer falha imprime ::error com o motivo e sai com 1.
# Fixado em ubuntu 24.04: no 26.04 o Playwright 1.55.0 não instala o Chromium (falha de 18/11/2026, run 44339134782).
set -uo pipefail
PW_VERSION="1.55.0"
falha() { echo "::error title=$1::$2"; exit 1; }
PW="${1:?diretório obrigatório}"
. /etc/os-release
echo "RUNNER_OS_VERSION=$ID $VERSION_ID"
[ "${CHROMIUM_PREFLIGHT_OS:-ubuntu 24.04}" = "$ID $VERSION_ID" ] \
  || falha CHROMIUM_PREFLIGHT_SO "sistema $ID $VERSION_ID: o deploy está fixado em ubuntu 24.04 (Playwright $PW_VERSION não suporta o Chromium no 26.04)"
mkdir -p "$PW" || falha CHROMIUM_PREFLIGHT_DIR "não foi possível criar $PW"
( cd "$PW" && npm init -y >/dev/null && npm install --no-save --no-audit --no-fund "playwright@$PW_VERSION" ) > "$PW/npm.log" 2>&1 \
  || falha CHROMIUM_PREFLIGHT_NPM "npm install playwright@$PW_VERSION falhou: $(tail -8 "$PW/npm.log" | tr '\n' ' ' | cut -c1-800)"
( cd "$PW" && npx playwright install --with-deps chromium ) > "$PW/install.log" 2>&1 \
  || falha CHROMIUM_PREFLIGHT_INSTALL "playwright install --with-deps chromium falhou: $(tail -8 "$PW/install.log" | tr '\n' ' ' | cut -c1-800)"
cat > "$PW/abrir.mjs" <<'JS'
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setContent('<title>ok</title>');
if (await p.title() !== 'ok') throw new Error('chromium_sem_render');
console.log('CHROMIUM_PREFLIGHT=PASS ' + b.version());
await b.close();
JS
( cd "$PW" && node abrir.mjs ) > "$PW/open.log" 2>&1 \
  || falha CHROMIUM_PREFLIGHT_ABRIR "o Chromium instalado não abriu: $(tail -8 "$PW/open.log" | tr '\n' ' ' | cut -c1-800)"
cat "$PW/open.log"
