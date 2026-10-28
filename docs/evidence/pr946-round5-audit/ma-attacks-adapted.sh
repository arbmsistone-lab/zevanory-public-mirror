#!/usr/bin/env bash
# r4 M-A: (1) texto jurídico fora do 1º <main> (comentário-isca) passa no portão; (2) passo do portão neutralizado passa na guarda.
set -uo pipefail
WT=${1:-/home/claude/arbmsistone-lab/wt-pr946-r4-audit}; W=$(mktemp -d); H=${H:-bbd58d9538b57396ed148e6637978aa31e57be23}; BASE=d01dd5ea8b85df2dbf8ccad2c6a9d6a95210f6d8
G="git -c user.email=a@a -c user.name=a"; export PYTHONDONTWRITEBYTECODE=1
git clone -q "$WT" "$W/r"; cd "$W/r"; git checkout -q -B gh-pages $H
# T0: estado estável em que o texto publicado == linha de base (gênese)
for f in sales-public/termos.html sales-public/reembolso.html termos/index.html reembolso/index.html; do git -C "$WT" show $BASE:$f > $f; done
for a in $(git -C "$WT" ls-tree -r --name-only $BASE sales-public/assets | grep -E 'legal\.[0-9a-f]+\.css$'); do git -C "$WT" show $BASE:$a > $a; git add $a; done  # ADAPTAÇÃO r6: T0 também restaura (e versiona no commit T0) o CSS jurídico da base (as páginas da base o referenciam; a impressão digital agora inclui assets)
python3 - "$WT" "$BASE" <<'PY'
import json,subprocess,sys
a=json.loads(subprocess.check_output(["git","-C",sys.argv[1],"show",sys.argv[2]+":data/politica-unica.json"]))
b=json.load(open("data/politica-unica.json"))
for k in ("sol_text","rule_7d","customer_wording","refund_channels"): b[k]=a.get(k)
b.pop("legal_document_version",None); json.dump(b,open("data/politica-unica.json","w"),ensure_ascii=False,indent=2)
PY
$G commit -qam T0; T0=$(git rev-parse HEAD); git update-ref refs/remotes/origin/gh-pages $T0
echo "T0: $(python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages | grep GATE=)"
# Ataque 1: isca em comentário
python3 - <<'PY'
import re
for f in ("termos/index.html","sales-public/termos.html","reembolso/index.html","sales-public/reembolso.html"):
    s=open(f,encoding="utf-8").read(); m=re.search(r"<main\b[^>]*>(.*?)</main>",s,re.S)
    s=s[:m.start()]+"<!--"+m.group(0)+"-->"+'<main><h1>Termos</h1><p>CLÁUSULA NOVA NÃO REVISADA: nenhum reembolso.</p></main>'+s[m.end():]
    open(f,"w",encoding="utf-8").write(s)
PY
$G commit -qam decoy; T1=$(git rev-parse HEAD)
echo "A1 guarda: $(python3 -I scripts/p23/trust_anchor_guard.py --pr-repo . --base-repo . --base-sha $T0 --head-sha $T1 | tail -1)"
git update-ref refs/remotes/origin/gh-pages $T1; python3 scripts/build_sales_public.py >/dev/null 2>&1
echo "A1 portão pós-merge: $(python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages | grep GATE=)  | publicado: $(grep -o 'CLÁUSULA NOVA[^<]*' sales-public/termos.html | head -1)"
git checkout -q -f $T0
python3 -c "f='termos/index.html';s=open(f,encoding='utf-8').read();open(f,'w',encoding='utf-8').write(s.replace('</main>','</main><section><h2>11. Nova</h2><p>Sem reembolso.</p></section>',1))"
echo "A1b texto depois de </main>: fp=$(python3 -I scripts/p23/legal_review.py --root . --fingerprint | cut -c1-12) (gênese 4f8d16325…)"
# Ataque 2: neutralizar o passo do portão com a #946 mesclada
for v in coe ift ortrue newwf; do
  git checkout -q -f $H
  case $v in
   coe) sed -i 's/^      - name: Legal review gate (M1; fail closed while the new legal text is PENDING)$/&\n        continue-on-error: true/' .github/workflows/zevanory-sales-public-release.yml .github/workflows/central-production-deploy.yml;;
   ift) sed -i 's/^      - name: Legal review gate (M1; fail closed while the new legal text is PENDING)$/&\n        if: ${{ false }}/' .github/workflows/central-production-deploy.yml;;
   ortrue) sed -i 's#--anchors-ref refs/remotes/origin/gh-pages$#& || true#' .github/workflows/zevanory-sales-public-release.yml .github/workflows/central-production-deploy.yml;;
   newwf) printf 'name: x\non: {push: {branches: [gh-pages]}}\njobs:\n  d:\n    runs-on: ubuntu-latest\n    environment: producao-critica\n    steps:\n      - uses: actions/checkout@v4\n      - run: python3 scripts/build_sales_public.py && npx --yes wrangler@4.143.0 deploy --config wrangler.sales.deploy.toml\n' > .github/workflows/x.yml; git add -A;;
  esac
  sed -i 's/9. Produtos de terceiros/9. Produtos de terceiros (sem reembolso)/' sales-public/termos.html
  $G commit -qam "$v"; echo "A2[$v] guarda: $(python3 -I scripts/p23/trust_anchor_guard.py --pr-repo . --base-repo . --base-sha $H --head-sha $(git rev-parse HEAD) | tail -1)"
done
rm -rf "$W"
