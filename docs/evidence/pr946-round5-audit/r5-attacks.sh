#!/usr/bin/env bash
# r5: ataques ao portão/fingerprint/validador no head ae8e4d51. Uso: r5-attacks.sh <worktree>
set -uo pipefail
WT=${1:?}; W=$(mktemp -d); H=0e890b12f1cb80aee5dd2bf2d1e1f711487c287f; BASE=d01dd5ea8b85df2dbf8ccad2c6a9d6a95210f6d8
G="git -c user.email=a@a -c user.name=a"; export PYTHONDONTWRITEBYTECODE=1
LEGAL="sales-public/termos.html sales-public/reembolso.html termos/index.html reembolso/index.html sales-public/privacidade.html sales-public/afiliados.html privacidade/index.html afiliados/index.html"
gate(){ python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages 2>&1 | grep -E 'GATE=|MAIN_INVALID' | cut -c1-90; }
fp(){ python3 -I scripts/p23/legal_review.py --root . --fingerprint 2>&1 | cut -c1-16; }
guard(){ python3 -I scripts/p23/trust_anchor_guard.py --pr-repo . --base-repo . --base-sha $1 --head-sha $(git rev-parse HEAD) | tail -1; }
valid(){ python3 -I scripts/p23/trust_anchor_guard.py --validate-workflows --root . | tail -1; }
git clone -q "$WT" "$W/r"; cd "$W/r"; git checkout -q -B gh-pages $H
for f in $LEGAL; do git -C "$WT" show $BASE:$f > $f; done
python3 - "$WT" "$BASE" <<'PY'
import json,subprocess,sys
a=json.loads(subprocess.check_output(["git","-C",sys.argv[1],"show",sys.argv[2]+":data/politica-unica.json"]))
b=json.load(open("data/politica-unica.json"))
for k in ("sol_text","rule_7d","customer_wording","refund_channels"): b[k]=a.get(k)
b.pop("legal_document_version",None); json.dump(b,open("data/politica-unica.json","w"),ensure_ascii=False,indent=2)
PY
$G commit -qam T0; T0=$(git rev-parse HEAD); git update-ref refs/remotes/origin/gh-pages $T0
FP0=$(fp); echo "T0 (estado estável = gênese): fp=$FP0 $(gate)"
edit(){ python3 - "$@" <<'PY'
import sys,re
mode=sys.argv[1]
for f in ("sales-public/reembolso.html","reembolso/index.html"):
    s=open(f,encoding="utf-8").read()
    if mode=="hide":   # esconde a 1ª seção <h2> com só atributo
        s=re.sub(r"<h2>", '<h2 style="display:none">', s, count=1); s=re.sub(r"(<h2 style=\"display:none\">.*?</h2>)\s*<p>", r'\1<p hidden>', s, count=1, flags=re.S)
    if mode=="input":
        s=s.replace("</main>",'<input readonly style="border:0;width:100%;font:inherit" value="CLÁUSULA NOVA: nenhum reembolso após o download."></main>',1)
    if mode=="srcdoc":
        s=s.replace("</main>",'<iframe style="border:0;width:100%" srcdoc="&lt;p&gt;CLÁUSULA NOVA: nenhum reembolso.&lt;/p&gt;"></iframe></main>',1)
    if mode=="attr":
        s=re.sub(r"<h1([^>]*)>", r'<h1\1 data-c=" — CLÁUSULA NOVA: nenhum reembolso">', s, count=1)
    open(f,"w",encoding="utf-8").write(s)
PY
}
for m in hide input srcdoc attr; do
  git checkout -q -f $T0; edit $m
  [ $m = attr ] && for c in sales-public/assets/legal.*.css; do echo 'h1[data-c]::after{content:attr(data-c)}' >> $c; done
  $G commit -qam $m; echo "C[$m]: fp=$(fp) (igual T0: $([ "$(fp)" = "$FP0" ] && echo SIM || echo nao)) guarda=$(guard $T0)"
done
# C5 CSS externo puro
git checkout -q -f $T0; for c in sales-public/assets/legal.*.css; do echo 'main h1::after{content:" — CLÁUSULA NOVA: nenhum reembolso"} main h2:nth-of-type(2), main h2:nth-of-type(2)+p{display:none}' >> $c; done; $G commit -qam css
echo "C[css]: fp igual T0: $([ "$(fp)" = "$FP0" ] && echo SIM || echo nao) guarda=$(guard $T0)"
# W1 transformação em runtime no Worker de vendas (rota servida /termos /reembolso passam por injectSiteChatHtml)
git checkout -q -f $T0
sed -i 's|^export function injectSiteChatHtml(html){$|&\n  html=String(html).replace("<h1>","<h1>CLÁUSULA NOVA: nenhum reembolso. ");|' worker/sales-public-worker.mjs
$G commit -qam w1; echo "W1: fp igual T0: $([ "$(fp)" = "$FP0" ] && echo SIM || echo nao) guarda=$(guard $T0) servido: $(node -e 'import("./worker/sales-public-worker.mjs").then(m=>{const h=require("fs").readFileSync("sales-public/reembolso.html","utf8");const o=m.injectSiteChatHtml(h);console.log((o.match(/CLÁUSULA NOVA[^<]*/)||["(ausente)"])[0])})')"
# B1 build_sales_public.py (código do repositório que roda DEPOIS do portão no job deploy) troca o texto e faz commit
git checkout -q -f $T0
cat >> scripts/build_sales_public.py <<'PY'

def _post():
    import subprocess, pathlib
    p = pathlib.Path(__file__).resolve().parents[1] / "sales-public" / "reembolso.html"
    p.write_text(p.read_text(encoding="utf-8").replace("<h1>", "<h1>CLÁUSULA NOVA: nenhum reembolso. ", 1), encoding="utf-8")
    subprocess.run(["git", "-c", "user.email=ci@x", "-c", "user.name=ci", "commit", "-qam", "build"], cwd=p.parents[1], check=False)
_post()
PY
$G commit -qam b1; B1=$(git rev-parse HEAD); echo "B1 guarda: $(guard $T0) | validador: $(valid)"
git update-ref refs/remotes/origin/gh-pages $B1
echo "B1 job deploy: 1) portão: $(gate)"
python3 scripts/build_sales_public.py >/dev/null 2>&1; echo "   2) build rc=$?"
git diff --exit-code HEAD -- $LEGAL data/politica-unica.json >/dev/null; echo "   3) integridade rc=$? | 4) publicado: $(grep -o 'CLÁUSULA NOVA[^<]*' sales-public/reembolso.html | head -1)"
# V1 validador (check obrigatório): passo de deploy não detectado com if: always() depois do portão
git checkout -q -f $H
python3 - <<'PY'
f=".github/workflows/zevanory-sales-public-release.yml"; s=open(f).read()
anchor="      - name: Require authenticated deployment authority\n"
s=s.replace(anchor,"      - name: Deploy anyway\n        if: always()\n        run: npx --yes \"wrangler@4.143.0\" deploy --config wrangler.sales.deploy.toml\n"+anchor,1); open(f,"w").write(s)
PY
$G commit -qam v1; echo "V1 validador (static-audit obrigatório): $(valid) | guarda protegida: $(guard $H)"
# V2 o PR remove o validador do próprio check obrigatório (pull_request usa a definição do PR)
python3 - <<'PY'
f=".github/workflows/product-pages-premerge.yml"; s=open(f).read()
i=s.index("      - name: Legal gate structure in the deploy workflows"); j=s.index("      - name: Sales promises match")
open(f,"w").write(s[:i]+s[j:])
PY
$G commit -qam v2; echo "V2 premerge sem o passo do validador: guarda protegida: $(guard $H); grep validador no premerge: $(grep -c validate-workflows .github/workflows/product-pages-premerge.yml)"
rm -rf "$W"
