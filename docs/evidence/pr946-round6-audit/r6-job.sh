#!/usr/bin/env bash
# r6: estado aprovado legítimo; PR-3 altera SÓ scripts/build_sales_public.py (não é âncora). Simula o job deploy de
# zevanory-sales-public-release.yml com os passos literais do head (portão inicial, build, portão final, deploy).
# MODE=worker : o build reescreve worker/sales-public-worker.mjs no workspace (o wrangler empacota o workspace)
# MODE=origin : o build troca remote.origin.url para um repositório falso cujo gh-pages tem um portão que sempre passa
set -uo pipefail
WT=${1:?}; FORGE2=${2:?}; MODE=${MODE:-worker}; W=$(mktemp -d); H=493a46034ece9481ad2369283bab52565bf5118c
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
# "merge" e checkout do runner
git clone -q --bare . "$W/remote.git"; git -C "$W/remote.git" update-ref refs/heads/gh-pages $S3
git clone -q "$W/remote.git" "$W/job"; cd "$W/job"; git checkout -q $S3
export GITHUB_SHA=$S3 RUNNER_TEMP=$(mktemp -d)
LEGAL="sales-public/termos.html sales-public/reembolso.html termos/index.html reembolso/index.html sales-public/privacidade.html sales-public/afiliados.html privacidade/index.html afiliados/index.html data/politica-unica.json"
gate(){ ( set -euo pipefail
  test "$(/usr/bin/git rev-parse HEAD)" = "$GITHUB_SHA"
  test -z "$(/usr/bin/git ls-files -v | grep -E '^([a-z]|S) ' || true)"
  /usr/bin/git diff --exit-code "$GITHUB_SHA" -- $LEGAL >/dev/null
  /usr/bin/git fetch --no-tags --quiet origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages
  /usr/bin/git show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > "$RUNNER_TEMP/legal_gate.py"
  /usr/bin/python3 -I "$RUNNER_TEMP/legal_gate.py" --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages ) 2>&1 | grep -E 'GATE=' ; return ${PIPESTATUS[0]}; }
echo "job: portão inicial: $(gate; echo " rc=$?")"
python3 scripts/build_sales_public.py >/dev/null 2>&1; echo "job: build rc=$?"
echo "job: portão final (antes do deploy): $(gate; echo " rc=$?")"
node --input-type=module -e '
const m=await import(process.cwd()+"/sales-worker.mjs"); const fs=await import("node:fs");
const env={ASSETS:{fetch:async(r)=>{const p=new URL(r.url).pathname;try{return new Response(fs.readFileSync("sales-public"+p),{status:200,headers:{"content-type":"text/html"}})}catch{return new Response("nf",{status:404})}}}};
const res=await m.default.fetch(new Request("https://vendas.zevanory.api.br/reembolso"),env,{waitUntil(){}});
const t=await res.text(); console.log("job: /reembolso servido pelo Worker empacotado:", (t.match(/CLÁUSULA NOVA[^<]*/)||["(texto original)"])[0]);' 2>&1 | tail -1
grep -ho 'CLÁUSULA NOVA[^"\\]*' sales-public/assets/legal.*.css | head -1 | sed 's/^/job: CSS servido: /'
echo "job: portão REAL (código do gh-pages verdadeiro) no mesmo artefato: $(python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref $S3 2>&1 | grep -E 'GATE=' | cut -c1-40)"
rm -rf "$W"
