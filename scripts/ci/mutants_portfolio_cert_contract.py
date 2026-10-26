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
    # --- pré-merge: base = fonte no SHA publicado, deriva por superfície
    ("M01 deriva contra a fonte publicada ignorada", "    if drift:\n", "    if False:\n"),
    ("M02 pré-merge compara produção à base do PR em vez do publicado",
     'drift = [{"field": f, "live": live[f], "deployed_source": deployed[f]} for f in LIVE_FIELDS if live[f] != deployed[f]]',
     'drift = [{"field": f, "live": live[f], "deployed_source": base[f]} for f in LIVE_FIELDS if live[f] != base[f]]'),
    ("M03 publicado fora da linhagem aceito", '        if s.get("relation") == "diverged":\n', "        if False:\n"),
    ("M04 SHA publicado ilegível aceito", '        if s.get("relation") in (None, "unresolvable"):\n', "        if False:\n"),
    ("M05 linhagem de gh-pages não verificada", "    if not _is_ancestor(deployed_sha, lineage_ref):\n", "    if False:\n"),
    ("M06 pendências não publicadas não registradas",
     "for f in CANDIDATE_FIELDS if deployed.get(f) != base.get(f)]", "for f in CANDIDATE_FIELDS if False]"),
    ("M07 relação behind/ahead invertida", '        return "behind_base"\n', '        return "ahead_of_base"\n'),
    ("M08 superfície que serve não registrada aceita", "    if serving not in surfaces:\n", "    if False:\n"),
    ("M09 base movida depois da ramificação aceita", "        if merge_base.get(f) != base.get(f):\n", "        if False:\n"),
    ("M10 linha fora do diff aceita", "        if not _intersects(lines, ranges):\n", "        if False:\n"),
    ("M11 mudança esperada não registrada", "        expected.append({", "        dict({"),
    ("M12 pré-merge sem base aceito", "    if base is None or merge_base is None or deployed is None:\n        raise",
     "    if base is None or merge_base is None or deployed is None:\n        return {}\n        raise"),
    ("M13 diff sem trecho na evidência", '"source_diff": hunks_for_lines(diff_text, lines)', '"source_diff": []'),
    ("M14 faixas do diff deslocadas", "            ranges.append((start, start + count - 1))",
     "            ranges.append((start + 1, start + count))"),
    ("M15 host desconhecido vira superfície central", '    raise ContractError("unknown_serving_surface", url=url)',
     '    return "central"'),
    ("M16 release não-SHA aceito", "    return v if _SHA.fullmatch(v) else None", "    return v or None"),
    # --- contexto
    ("M17 todo evento vira pré-merge",
     'derived = PRE_MERGE if (event_name or "") == "pull_request" else POST_DEPLOY', "derived = PRE_MERGE"),
    ("M18 CERT_CONTEXT declarado pode relaxar", '    if declared not in (None, "") and declared != derived:\n',
     "    if False:\n"),
    ("M19 workflow_run sem superfície do deploy aceito", "        if trigger_surface not in SURFACES:\n", "        if False:\n"),
    # --- pós-publicação: só depois da promoção observada
    ("M20 pós-publicação deixa de comparar", "        if live[f] != head[f]:\n", "        if False:\n"),
    ("M21 pós-publicação compara só title", "    for f in LIVE_FIELDS:\n        if live[f] != head[f]:",
     "    for f in LIVE_FIELDS[:1]:\n        if live[f] != head[f]:"),
    ("M22 compara sem promoção observada", '    if not promotion or promotion.get("state") != "PROMOTED":\n',
     "    if False:\n"),
    ("M23 superfície do deploy não precisa reportar o SHA exato",
     "        trig_ok = trigger is None or trig == expected_sha", "        trig_ok = True"),
    ("M24 superfície que serve não precisa ter a fonte esperada",
     "        serv_ok = bool(serv_fields) and all(", "        serv_ok = True or all("),
    ("M25 prazo esgotado passa em vez de falhar", "        if clock() >= deadline:\n            code",
     "        if clock() >= deadline:\n            return {\"state\": \"PROMOTED\", **obs}\n            code"),
    ("M26 adiamento do push rotulado como mismatch",
     'code = "promotion_not_observed" if trigger else "post_deploy_deferred"', 'code = "live_title_mismatch"'),
    ("M27 não espera (uma tentativa só)", "        sleep(interval)\n", "        raise ContractError(\"post_deploy_deferred\")\n"),
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
