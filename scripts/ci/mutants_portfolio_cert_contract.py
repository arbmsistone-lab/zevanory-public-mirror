#!/usr/bin/env python3
"""Mutantes do contrato v2 da certificação do portfólio (pré-merge x pós-publicação).

Cada mutante enfraquece uma garantia de scripts/portfolio_cert_contract.py; a suíte
tests/test_portfolio_cert_contract.py tem de falhar (KILLED) para todos. Baseline limpa é exigida antes.
Sai com 1 se algum mutante sobreviver, se a mutação não se aplicar ou se a baseline falhar.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts/portfolio_cert_contract.py"

MUTANTS = [
    ("M01 deriva pré-merge ignorada", "    if drift:\n", "    if False:\n"),
    ("M02 pré-merge compara produção ao candidato, não à base",
     'drift = [{"field": f, "live": live[f], "base": base[f]} for f in LIVE_FIELDS if live[f] != base[f]]',
     'drift = [{"field": f, "live": live[f], "base": head[f]} for f in LIVE_FIELDS if live[f] != head[f]]'),
    ("M03 pós-publicação deixa de comparar", "            if live[f] != head[f]:\n", "            if False:\n"),
    ("M04 pós-publicação compara só title", "        for f in LIVE_FIELDS:\n            if live[f] != head[f]:",
     "        for f in LIVE_FIELDS[:1]:\n            if live[f] != head[f]:"),
    ("M05 todo evento vira pré-merge",
     'derived = PRE_MERGE if (event_name or "") == "pull_request" else POST_DEPLOY', "derived = PRE_MERGE"),
    ("M06 CERT_CONTEXT declarado pode relaxar", '    if declared not in (None, "") and declared != derived:\n',
     "    if False:\n"),
    ("M07 base movida depois da ramificação aceita", "        if merge_base.get(f) != base.get(f):\n", "        if False:\n"),
    ("M08 linha fora do diff aceita", "        if not _intersects(lines, ranges):\n", "        if False:\n"),
    ("M09 mudança esperada não registrada", "        expected.append({", "        dict({"),
    ("M10 pré-merge sem base aceito", "    if base is None or merge_base is None:\n        raise",
     "    if base is None or merge_base is None:\n        return {}\n        raise"),
    ("M11 contexto desconhecido aceito como pré-merge", "    if context != PRE_MERGE:\n", "    if False:\n"),
    ("M12 diff sem trecho na evidência", '"source_diff": hunks_for_lines(diff_text, lines)', '"source_diff": []'),
    ("M13 ponta de gh-pages já publicada ignorada", '            candidates.append(("gh_pages_tip", tip))\n',
     "            pass\n"),
    ("M14 faixas do diff deslocadas", "            ranges.append((start, start + count - 1))",
     "            ranges.append((start + 1, start + count))"),
]


def run_suite(path):
    env = {**os.environ, "PORTFOLIO_CERT_CONTRACT_PATH": str(path), "PYTHONDONTWRITEBYTECODE": "1"}
    p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "tests"), "-p",
                        "test_portfolio_cert_contract.py"], env=env, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=300)
    return p.returncode, p.stdout + p.stderr


def main():
    src = SRC.read_text("utf-8")
    rc, out = run_suite(SRC)
    if rc != 0:
        print(out)
        print("BASELINE=FAIL")
        return 1
    print("BASELINE=PASS")
    bad = 0
    with tempfile.TemporaryDirectory() as d:
        for name, old, new in MUTANTS:
            if src.count(old) != 1:
                print(f"MUTANT {name}: NOT_APPLIED (trecho ocorre {src.count(old)} vezes)")
                bad += 1
                continue
            mp = pathlib.Path(d, "portfolio_cert_contract.py")
            mp.write_text(src.replace(old, new), "utf-8")
            rc, out = run_suite(mp)
            verdict = "KILLED" if rc != 0 and ("FAILED" in out) else "SURVIVED"
            if verdict != "KILLED":
                bad += 1
            print(f"MUTANT {name}: {verdict}")
    print(f"MUTANTS_TOTAL={len(MUTANTS)} NOT_KILLED={bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
