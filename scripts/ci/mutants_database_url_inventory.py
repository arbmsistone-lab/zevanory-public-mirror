#!/usr/bin/env python3
"""Mutantes B07 T4 (database-url-consumer-inventory): cada mutante altera uma CÓPIA temporária do script ou do workflow,
roda tests/test_database_url_inventory.py contra ela; o original nunca é modificado.
Imprime `MUTANT <id> KILLED|SURVIVED` e sai != 0 se algum sobreviver ou se a suíte sem mutação falhar.
Uso: python3 scripts/ci/mutants_database_url_inventory.py [raiz-do-repo]
"""
import os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
S = (REPO / "scripts/ops/database_url_inventory.py").read_text()
W = (REPO / ".github/workflows/database-url-consumer-inventory.yml").read_text()
TARGET = {"S": ("DBINV_SCRIPT", "database_url_inventory.py", S), "W": ("DBINV_WORKFLOW", "wf.yml", W)}


def sub(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new, 1)


M = {
    "D1 pooler suffix not normalized": ("S", 'first = first[: -len("-pooler")] if pooled else first', 'pass'),
    "D2 hash of the full URL instead of the host": ("S", 'return sha(norm), (sha(endpoint)', 'return sha(str(url)), (sha(endpoint)'),
    "D3 endpoint id printed in clear": ("S", '(sha(endpoint) if endpoint else None)', '(endpoint if endpoint else None)'),
    "D4 host not lower-cased": ("S", 'host = (parts.hostname or "").lower().rstrip(".")', 'host = (parts.netloc.rsplit("@", 1)[-1].split(":")[0] or "").rstrip(".")'),
    "D5 any scheme accepted": ("S", 'if parts.scheme not in ("postgres", "postgresql") or not host', 'if not host'),
    "D6 mismatch tolerated": ("S", 'if status not in ("MATCH", "ISOLATED"):', 'if status in ("ABSENT", "UNPARSEABLE"):'),
    "D7 absent secret tolerated": ("S", 'status, h, e, pooled = "ABSENT", "none", "none", "-"', 'status, h, e, pooled = "MATCH", "none", "none", "-"'),
    "D8 certification isolation not enforced": ("S", '("ISOLATED" if not same else "NOT_ISOLATED")', '"ISOLATED"'),
    "D9 expected input not validated": ("S", 'if not HEX64.fullmatch(exp):', 'if not exp:'),
    "D10 stops at the first divergence": ("S", 'bad.append(f"{secret}[{\',\'.join(workflows)}]={status}")', 'return fail("DBURL_INVENTORY_FAIL", f"env={env_name} {secret}[{\',\'.join(workflows)}]={status}")'),
    "D11 no masking under Actions": ("S", 'for v in (host, norm, endpoint, parts.username, parts.password):\n        mask(v)', 'pass'),
    "D12 worker missing field accepted": ("S", 'status = "MISSING_FIELD"', 'status = "MATCH"'),
    "D13 worker field echoed unvalidated": ("S", 'shown = got if isinstance(got, str) and HEX64.fullmatch(got) else "none"', 'shown = got'),
    "D14 consumer table drops a workflow": ("S", '"financial-ddl-readonly-check.yml",\n', ''),
    "D15 worker HTTP status ignored": ("S", 'if code not in ("200", "503") or not isinstance(data, dict):', 'if not isinstance(data, dict):'),
    "W1 verdict ignores the worker job": ("W", '"$R_PROD$R_AUTO$R_CERT$R_WORKER" != "successsuccesssuccesssuccess"', '"$R_PROD$R_AUTO$R_CERT" != "successsuccesssuccess"'),
    "W2 push trigger added": ("W", 'on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [gh-pages]\n  workflow_dispatch:'),
    "W3 input interpolated in run": ("W", 'run: python3 scripts/ops/database_url_inventory.py worker', 'run: EXPECTED_HOST_SHA256=${{ inputs.expected_host_sha256 }} python3 scripts/ops/database_url_inventory.py worker'),
    "W4 production secret missing from its job": ("W", '          DBINV_RESTORE_TARGET_DATABASE_URL: ${{ secrets.RESTORE_TARGET_DATABASE_URL }}\n', ''),
    "W5 verdict not always": ("W", "if: always() && github.ref == 'refs/heads/gh-pages'", "if: github.ref == 'refs/heads/gh-pages'"),
    "W6 write permission": ("W", 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
}


def run(env_extra, failfast=False):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **env_extra}
    cmd = [sys.executable, "-m", "unittest"] + (["-f"] if failfast else []) + ["tests.test_database_url_inventory"]
    return subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=600)


def one(item):
    name, (which, old, new) = item
    var, fname, text = TARGET[which]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / fname
        f.write_text(sub(text, old, new))
        p = run({var: str(f)}, failfast=True)
    return name, p.returncode != 0


base = run({})
if base.returncode != 0:
    print(base.stderr[-3000:])
    print("MUTANT BASELINE FAILED (suíte sem mutação não passa)")
    sys.exit(2)
print("MUTANT BASELINE PASS", flush=True)
survivors = 0
with ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2)) as ex:
    for name, killed in ex.map(one, M.items()):
        mid = name.split()[0]
        survivors += 0 if killed else 1
        print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} — {name[len(mid) + 1:]}", flush=True)
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
