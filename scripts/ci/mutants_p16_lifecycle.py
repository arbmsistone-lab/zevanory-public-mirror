#!/usr/bin/env python3
"""Mutantes causais do P16 seguindo P13 (scripts/portfolio_target_lifecycle.py), classificados pelo classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/ci/p16-target-lifecycle.test.mjs (L1-L18), que roda o main() real do
script via tests/helpers/p16_lifecycle_harness.py com fixtures (sem rede). Cada mutante altera UMA regra do script numa
cópia mínima da árvore em diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p16_lifecycle_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Ln.k] da asserção que codifica a regra) e secondary com justification, escritas
por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary
sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p16_lifecycle.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/ci/p16-target-lifecycle.test.mjs"]
SLUGS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"]
COPY_DIRS = ["tests/fixtures/p16"]
COPY_FILES = TESTS + ["scripts/portfolio_target_lifecycle.py", "tests/helpers/p16_lifecycle_harness.py", "tests/helpers/toolchain.mjs",
                      "worker/sales-public-worker.mjs", "worker/politica-unica.mjs", "data/politica-unica.json",
                      "worker/cloudflare-worker.recovered.mjs"] + \
    [f"sales-public/{s}.html" for s in SLUGS] + [f"{s}/index.html" for s in SLUGS] + [f"evidence/zees16/coverage/{s}.json" for s in SLUGS]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
P = "scripts/portfolio_target_lifecycle.py"

M = {
    "M01 pre-fix: buy CTA required regardless of switch": (P, "    if sales_open:\n        # Live sales contract", "    if True:\n        # Live sales contract"),
    "M02 closed accepts /comprar/": (P, '    assert "/comprar/" not in live.lower(),(slug,"closed_buy_href_present")\n', ""),
    "M03 closed accepts external checkout": (P, '    assert not m,(slug,"closed_external_checkout_present",m.group(0) if m else None)\n', ""),
    "M04 closed accepts visible buy CTA": (P, '    assert not buy,(slug,"closed_buy_cta_present",buy[:3])', '    assert True or not buy,(slug,"closed_buy_cta_present",buy[:3])'),
    "M05 closed buy CTA by raw substring (attribute counted)": (P, '    buy=[c["text"] for c in controls if BUY_WORD.search(c["text"])]', '    buy=["raw"] if "Comprar agora" in live else []'),
    "M06 closed accepts InStock": (P, '    assert "schema.org/instock" not in live.lower(),(slug,"closed_instock_present")\n', ""),
    "M07 closed waitlist CTA not required": (P, '    assert waiting,(slug,"closed_waitlist_cta_missing")', '    assert True,(slug,"closed_waitlist_cta_missing")'),
    "M08 closed waitlist not bound to SKU": (P, ' and c["attrs"].get("data-zev-sku")==sku', ""),
    "M09 closed waitlist dead href accepted": (P, '\n             and c["attrs"].get("href","").strip() not in ("","#")', ""),
    "M10 closed label not required": (P, '    assert CLOSED_LABEL in live.lower(),(slug,"closed_label_missing")\n', ""),
    "M11 status open by truthiness": (P, '    assert isinstance(state,bool),(slug,"sales_status_ambiguous","open_not_boolean",state)', "    state=bool(state)"),
    "M12 status open with blocked accepted": (P, '    if state:\n        assert body.get("blocked") is None,(slug,"sales_status_ambiguous","open_with_blocked",body.get("blocked"))\n', ""),
    "M13 status non-200 accepted": (P, '    assert code==200,(slug,"sales_status_unreadable","http",code)\n', ""),
    "M14 status network error read as closed": (P, '        raise AssertionError((SLUG,"sales_status_unreadable","network",type(e).__name__))', "        code,raw=200,'{\"open\":false}'"),
    "M15 status non-JSON read as closed": (P, '        raise AssertionError((slug,"sales_status_unreadable","json"))', '        body={"open":False}'),
    "M16 open buy anchor not required": (P, '        assert anchors,(slug,"open_buy_anchor_missing")', '        assert True,(slug,"open_buy_anchor_missing")'),
    "M17 open foreign SKU accepted": (P, '        assert not foreign,(slug,"open_foreign_buy_target",foreign)\n', ""),
    "M18 open waitlist leftover accepted": (P, '        assert not waiting,(slug,"open_waitlist_still_present",len(waiting))\n', ""),
    "M19 open closed-label leftover accepted": (P, '        assert CLOSED_LABEL not in live.lower(),(slug,"open_closed_label_still_present")\n', ""),
    "M20 release sales_mode cross-check removed": (P, '    assert release.get("sales_mode")==expected_sales,(SLUG,"sales_mode_mismatch",release.get("sales_mode"),expected_sales)\n', ""),
    "M21 switch reading inverted": (P, "    sales_open=parse_sales_status(SLUG,code,raw)", "    sales_open=not parse_sales_status(SLUG,code,raw)"),
    "M22 guarantee not required": (P, '    assert "7 dias" in live,(slug,"guarantee_missing")\n', ""),
    "M23 supplier identification not required": (P, '    assert "CNPJ 69.077.233/0001-99" in live,(slug,"supplier_identification_missing")\n', ""),
    "M24 open buy target substring not required": (P, '        assert f"/comprar/{sku}" in live,(slug,"buy_target_missing")\n', ""),
}

ALLOW_FILE = Path(os.environ.get("P16_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p16_lifecycle_allow.json"))


def load_config(path=None, titles=None, mutants=None):
    raw = json.loads(Path(path or ALLOW_FILE).read_text(encoding="utf-8"))
    specs = raw.get("mutants") if isinstance(raw, dict) else None
    if not isinstance(specs, dict):
        raise mc.ConfigError("config sem a seção 'mutants'")
    cfg = mc.load_mutant_config(specs)
    mutants = M if mutants is None else mutants
    missing, orphan = sorted(set(mutants) - set(cfg)), sorted(set(cfg) - set(mutants))
    if missing or orphan:
        raise mc.ConfigError(f"mutantes sem config {missing} / config órfã {orphan}")
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        if titles is not None:
            for e in spec["primary"] + spec["secondary"]:
                if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                    raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern'][:60]}")
    return cfg


def build(tmp, mutation=None):
    for rel in COPY_DIRS:
        shutil.copytree(Path(REPO, *rel.split("/")), Path(tmp, *rel.split("/")), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for rel in COPY_FILES:
        dst = Path(tmp, *rel.split("/"))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(REPO, *rel.split("/")), dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp, *rel.split("/"))
        text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "PYTHONDONTWRITEBYTECODE": "1"}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    total = parsed["summary"].get("tests")
    vb = mc.validate_baseline(total if isinstance(total, int) else -1, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        print(base.get("stdout", "")[-3000:])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={total}")
    try:
        cfg = load_config(titles=titles)
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(item):
        name, mutation = item
        res = run_mutant(name, mutation, total, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, mutation, total, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
