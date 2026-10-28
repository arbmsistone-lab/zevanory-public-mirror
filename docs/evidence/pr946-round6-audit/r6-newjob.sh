#!/usr/bin/env bash
# r6: estado aprovado legítimo; PR-3 altera SÓ scripts/build_sales_public.py (não é âncora). Simula o job deploy de
# zevanory-sales-public-release.yml com os passos literais do head (portão inicial, build, portão final, deploy).
# MODE=worker : o build reescreve worker/sales-public-worker.mjs no workspace (o wrangler empacota o workspace)
# MODE=origin : o build troca remote.origin.url para um repositório falso cujo gh-pages tem um portão que sempre passa
set -uo pipefail
WT=${1:?}; FORGE2=${2:?}; MODE=${MODE:-worker}; W=$(mktemp -d); H=${H:-9c563be02123772b1fe610e1642db60cf3271352}  # ADAPTAÇÃO r7: H do ambiente
G="git -c user.email=a@a -c user.name=a"; export PYTHONDONTWRITEBYTECODE=1
git clone -q "$WT" "$W/dev"; cd "$W/dev"; git checkout -q -B gh-pages $H; git update-ref refs/remotes/origin/gh-pages $H
python3 - <<'PY'
import json; p="data/p23/legal-reviewers.json"; d=json.load(open(p))
d["reviewers"]=[{"id":"rev-1","name":"Maria Souza","registro":"OAB/CE 12345","github_login":"revisora","authorized_by":"proprietario","authorized_at":"2026-10-27"}]
json.dump(d,open(p,"w"),ensure_ascii=False,indent=1)
PY
$G commit -qam "PR-1 cadastro"; S1=$(git rev-parse HEAD); git update-ref refs/remotes/origin/gh-pages $S1
python3 "$FORGE2" "$S1" "$(python3 -I scripts/p23/legal_review.py --root . --fingerprint)" "$(python3 -c "import json;print(json.load(open('data/politica-unica.json'))['legal_document_version'])")" "$H"
git add -A; $G commit -qm "PR-2 aprovação"; S2=$(git rev-parse HEAD); git update-ref refs/remotes/origin/gh-pages $S2
echo "S2 aprovado: $(python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages | grep GATE=)"
python3 - "$MODE" <<'PY'
import sys
mode=sys.argv[1]; f="scripts/build_sales_public.py"; s=open(f,encoding="utf-8").read()
if mode=="worker":
    post='''def _post():
    import pathlib
    w = pathlib.Path(__file__).resolve().parents[1] / "worker" / "sales-public-worker.mjs"
    s = w.read_text(encoding="utf-8")
    s = s.replace("return new Response(request.method===\\"HEAD\\"?null:response.body,", "return new Response(request.method===\\"HEAD\\"?null:(await response.text()).replace(\\"<h1>\\",\\"<h1>CLÁUSULA NOVA: nenhum reembolso. \\"),", 1)
    w.write_text(s, encoding="utf-8")

'''
else:
    post='''def _post():
    import pathlib, subprocess, os, tempfile
    root = pathlib.Path(__file__).resolve().parents[1]
    fake = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", fake], check=True)
    (pathlib.Path(fake) / "scripts" / "p23").mkdir(parents=True)
    (pathlib.Path(fake) / "scripts" / "p23" / "legal_review.py").write_text("print('LEGAL_PUBLISH_GATE=PASS_APPROVED (falso)')\\n")
    subprocess.run(["git", "-C", fake, "-c", "user.email=x@x", "-c", "user.name=x", "checkout", "-qb", "gh-pages"], check=True)
    subprocess.run(["git", "-C", fake, "add", "-A"], check=True)
    subprocess.run(["git", "-C", fake, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qm", "f"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "remote.origin.url", fake], check=True)
    for c in (root / "sales-public" / "assets").glob("legal.*.css"):
        c.write_text(c.read_text(encoding="utf-8") + "\\nmain h1::after{content:\\" CLÁUSULA NOVA: nenhum reembolso.\\"}\\n", encoding="utf-8")

'''
s=s.replace('if __name__ == "__main__":\n    raise SystemExit(main())', post + 'if __name__ == "__main__":\n    _rc = main(); _post(); raise SystemExit(_rc)')
open(f,"w",encoding="utf-8").write(s)
PY
$G commit -qam "PR-3 só build_sales_public.py"; S3=$(git rev-parse HEAD)
echo "PR-3 guarda protegida: $(python3 -I scripts/p23/trust_anchor_guard.py --pr-repo . --base-repo . --base-sha $S2 --head-sha $S3 | tail -1)"
# ===== ADAPTAÇÃO r7 (daqui em diante): os passos antigos acima simulavam UM job com build e deploy juntos. O head
# novo tem jobs separados; abaixo cada job roda num clone próprio, como em runners diferentes, e o passo do portão é
# EXTRAÍDO do workflow do head (sem edição). Tudo acima desta linha é o script original do auditor.
git clone -q --bare . "$W/remote.git"; git -C "$W/remote.git" update-ref refs/heads/gh-pages $S3
export GITHUB_SHA=$S3
# site-build (sem segredo): roda o build do PR-3 (malicioso) no próprio workspace e empacota sales-public.
git clone -q "$W/remote.git" "$W/site"; cd "$W/site"; git checkout -q $S3
python3 scripts/build_sales_public.py >/dev/null 2>&1; echo "site-build: build rc=$? | segredo no job site-build do workflow: $(python3 -c "import yaml;j=yaml.safe_load(open('.github/workflows/zevanory-sales-public-release.yml'))['jobs']['site-build'];print('SIM' if 'secrets.' in str(j) else 'NAO')")"
echo "site-build: remote.origin.url (só deste workspace) = $(git config remote.origin.url | sed 's#.*/##')"
mkdir -p "$W/art/site"; cp -a sales-public "$W/art/site/sales-public"
# worker-bundle (sem segredo, só código âncora): clone próprio; NÃO roda scripts/build_sales_public.py.
git clone -q "$W/remote.git" "$W/wb"; cd "$W/wb"; git checkout -q $S3
echo "worker-bundle: o job executa build_sales_public? $(python3 -c "import yaml;j=yaml.safe_load(open('.github/workflows/zevanory-sales-public-release.yml'))['jobs']['worker-bundle'];print('SIM' if 'build_sales_public' in str(j) else 'NAO')")"
# deploy: checkout confiável do SHA do evento em base/ (clone próprio, origin = repositório) + artefato do site.
mkdir -p "$W/job"; git clone -q "$W/remote.git" "$W/job/base"; git -C "$W/job/base" checkout -q $S3
cp -a "$W/art" "$W/job/art"
BODY="$(python3 - "$W/job/base/.github/workflows/zevanory-sales-public-release.yml" <<'PY3'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"      - name: Legal artifact gate before the candidate deploy\n        run: \|\n((?:          [^\n]*\n)+)", s)
print("".join(l[10:] + "\n" for l in m.group(1).splitlines()))
PY3
)"
cd "$W/job"; out="$(RUNNER_TEMP=$(mktemp -d) bash -c "$BODY" 2>&1)"; rc=$?
echo "deploy: passo do portão do head (antes do deploy): $(echo "$out" | grep -E 'GATE=' | cut -c1-60) rc=$rc"
node --input-type=module -e '
const m=await import(process.argv[1]+"/sales-worker.mjs"); const fs=await import("node:fs");
const env={ASSETS:{fetch:async(r)=>{const p=new URL(r.url).pathname;try{return new Response(fs.readFileSync(process.argv[2]+p),{status:200,headers:{"content-type":"text/html"}})}catch{return new Response("nf",{status:404})}}}};
const res=await m.default.fetch(new Request("https://vendas.zevanory.api.br/reembolso"),env,{waitUntil(){}});
const t=await res.text(); console.log("deploy: /reembolso servido pelo pacote do worker-bundle (fontes âncora) com os assets do artefato:", (t.match(/CLÁUSULA NOVA[^<]*/)||["(texto original)"])[0]);' "$W/wb" "$W/job/art/site/sales-public" 2>&1 | tail -1
echo "deploy: CSS do artefato traz a cláusula? $(grep -lq 'CLÁUSULA NOVA' "$W"/job/art/site/sales-public/assets/legal.*.css && echo SIM || echo NAO)"
rm -rf "$W"
