#!/usr/bin/env bash
# r5 N: workflow NOVO que publica sem ser detectado pela guarda (DEPLOY_LINE/PROD_ENV são regex de linha).
set -uo pipefail
WT=${1:?}; W=$(mktemp -d); H=0e890b12f1cb80aee5dd2bf2d1e1f711487c287f; G="git -c user.email=a@a -c user.name=a"; export PYTHONDONTWRITEBYTECODE=1
git clone -q "$WT" "$W/r"; cd "$W/r"
try(){ git checkout -q -f $H; printf "$2" > .github/workflows/n.yml; git add -A; $G commit -qm "$1"; echo "N[$1]: $(python3 -I scripts/p23/trust_anchor_guard.py --pr-repo . --base-repo . --base-sha $H --head-sha $(git rev-parse HEAD) | tail -1)"; }
HDR='name: n\non:\n  push:\n    branches: [gh-pages]\njobs:\n  d:\n    runs-on: ubuntu-latest\n'
try quoted  "${HDR}"'    environment:\n      name: producao-critica\n    steps:\n      - uses: actions/checkout@v4\n      - run: npx --yes "wrangler@4.143.0" deploy --config wrangler.sales.deploy.toml\n'
try varcmd  "${HDR}"'    environment: { name: producao-critica }\n    steps:\n      - uses: actions/checkout@v4\n      - run: W=wrangler; npx --yes $W deploy --config wrangler.sales.deploy.toml\n'
try npmscript "${HDR}"'    environment:\n      name: producao-critica\n    steps:\n      - uses: actions/checkout@v4\n      - run: node scripts/deploy/any.mjs\n'
try reusable "${HDR%    runs-on: ubuntu-latest\\n}"'    uses: ./.github/workflows/zevanory-sales-public-release.yml\n    secrets: inherit\n'
try apicurl "${HDR}"'    steps:\n      - uses: actions/checkout@v4\n      - run: curl -X PUT -H "Authorization: Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}" https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/zevanory-sales-public -F metadata=@m.json\n'
rm -rf "$W"
