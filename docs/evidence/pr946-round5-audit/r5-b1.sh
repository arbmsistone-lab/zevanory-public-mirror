#!/usr/bin/env bash
# r5 B1: estado aprovado legítimo (cadastro e aprovação em 2 PRs do proprietário); depois um PR comum altera SÓ
# scripts/build_sales_public.py, que roda depois do portão no job deploy e troca o texto jurídico com commit local.
set -uo pipefail
WT=${1:?}; FORGE2=${2:?}; W=$(mktemp -d); H=0e890b12f1cb80aee5dd2bf2d1e1f711487c287f
G="git -c user.email=a@a -c user.name=a"; export PYTHONDONTWRITEBYTECODE=1
LEGAL="sales-public/termos.html sales-public/reembolso.html termos/index.html reembolso/index.html sales-public/privacidade.html sales-public/afiliados.html privacidade/index.html afiliados/index.html"
gate(){ python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages 2>&1 | grep -E 'GATE=' | cut -c1-60; }
git clone -q "$WT" "$W/r"; cd "$W/r"; git checkout -q -B gh-pages $H
python3 - <<'PY'
import json; p="data/p23/legal-reviewers.json"; d=json.load(open(p))
d["reviewers"]=[{"id":"rev-1","name":"Maria Souza","registro":"OAB/CE 12345","github_login":"revisora","authorized_by":"proprietario","authorized_at":"2026-10-27"}]
json.dump(d,open(p,"w"),ensure_ascii=False,indent=1)
PY
$G commit -qam "PR-1 cadastro"; S1=$(git rev-parse HEAD)
python3 "$FORGE2" "$S1" "$(python3 -I scripts/p23/legal_review.py --root . --fingerprint)" "$(python3 -c "import json;print(json.load(open('data/politica-unica.json'))['legal_document_version'])")" "$H"
git add -A; $G commit -qm "PR-2 aprovação"; S2=$(git rev-parse HEAD); git update-ref refs/remotes/origin/gh-pages $S2
echo "S2 (aprovado): $(gate)"
python3 - <<'PY2'
f="scripts/build_sales_public.py"; s=open(f,encoding="utf-8").read()
post = """def _post():
    import subprocess, pathlib
    root = pathlib.Path(__file__).resolve().parents[1]
    p = root / "sales-public" / "reembolso.html"
    p.write_text(p.read_text(encoding="utf-8").replace("<h1>", "<h1>CLÁUSULA NOVA: nenhum reembolso. ", 1), encoding="utf-8")
    subprocess.run(["git", "-c", "user.email=ci@x", "-c", "user.name=ci", "commit", "-qam", "build"], cwd=root, check=False)

"""
s=s.replace('if __name__ == "__main__":\n    raise SystemExit(main())', post + 'if __name__ == "__main__":\n    _rc = main(); _post(); raise SystemExit(_rc)')
open(f,"w",encoding="utf-8").write(s)
PY2
$G commit -qam "PR-3 só build_sales_public.py"; S3=$(git rev-parse HEAD)
echo "PR-3 guarda protegida: $(python3 -I scripts/p23/trust_anchor_guard.py --pr-repo . --base-repo . --base-sha $S2 --head-sha $S3 | tail -1) | validador: $(python3 -I scripts/p23/trust_anchor_guard.py --validate-workflows --root . | tail -1)"
git update-ref refs/remotes/origin/gh-pages $S3
echo "job deploy em S3: 1) portão: $(gate)"
python3 scripts/build_sales_public.py >/dev/null 2>&1; echo "  2) build rc=$?"
git diff --exit-code HEAD -- $LEGAL data/politica-unica.json >/dev/null; echo "  3) integridade rc=$?  4) publicado: $(grep -o 'CLÁUSULA NOVA[^<]*' sales-public/reembolso.html | head -1)"
rm -rf "$W"
