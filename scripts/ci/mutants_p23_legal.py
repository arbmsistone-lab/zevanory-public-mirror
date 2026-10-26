#!/usr/bin/env python3
"""Mutantes causais do P23 (comércio eletrônico e trava fiscal): gate scripts/p23/ecommerce_legal_gate.py, registro
worker/fiscal-process.mjs e sinal 'fiscal' de worker/commercial-checkout-guard.mjs, classificados pelo classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p23-ecommerce-legal.test.mjs (L1-L18). Cada mutante altera UMA regra numa
cópia mínima da árvore em diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p23_legal_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Ln.k]) e secondary com justification, escritas por raciocínio sobre a mutação
ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary sem marcador, test_pattern
que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p23_legal.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p23-ecommerce-legal.test.mjs"]
COPY_DIRS = []
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/helpers/toolchain.mjs", "scripts/p23/ecommerce_legal_gate.py",
                      "worker/fiscal-process.mjs", "worker/commercial-checkout-guard.mjs", "worker/sales-control.mjs",
                      "worker/cloudflare-worker.compat.mjs", "data/politica-unica.json", "data/products.json",
                      "data/p23/fiscal-process.json", "data/p23/ecommerce-legal-checklist.json"] + \
    sorted(f"sales-public/{p.name}" for p in (REPO / "sales-public").glob("*.html")) + \
    sorted(p.relative_to(REPO).as_posix() for p in REPO.glob("*/index.html") if p.parent.name != "sales-public")
TIMEOUT = 300
NODE = shutil.which("node") or "node"
G = "scripts/p23/ecommerce_legal_gate.py"
F = "worker/fiscal-process.mjs"
C = "worker/commercial-checkout-guard.mjs"
SC = "worker/sales-control.mjs"

M = {
    "M01 registro fiscal sem exigir DEFINIDO": (F, '  if (!record || record.status !== "DEFINIDO") return false;', "  if (!record) return false;"),
    "M02 campos da decisão não exigidos": (F, "    } else if (!filled(d[k])) return false;", "    } else if (false) return false;"),
    "M03 decisão por quem não é o proprietário": (F, '  if (d.decided_by !== "proprietario") return false;\n', ""),
    "M04 decisão datada no futuro aceita": (F, "  return Number.isFinite(at) && at <= now;", "  return Number.isFinite(at);"),
    "M05 portão sem o sinal fiscal": (C, '"environment","fiscal","token"', '"environment","token"'),
    "M06 sinal fiscal sempre verdadeiro": (C, "    fiscal:fiscalProcessDefined(fiscal,now),", "    fiscal:true,"),
    "M07 identificação do fornecedor não conferida": (G, "            if need not in vis:\n", "            if False:\n"),
    "M08 campo do resumo ausente aceito": (G, "            if not v:\n                errs.append(f\"{where}: Resumo da oferta sem o campo", "            if False:\n                errs.append(f\"{where}: Resumo da oferta sem o campo"),
    "M09 preço diferente do catálogo aceito": (G, '        elif f"R$ {want},00" not in r.get("preco_total", ""):', "        elif False:"),
    "M10 arrependimento não conferido": (G, '        if "7 dias corridos" not in arr or "devolução integral" not in arr:', "        if False:"),
    "M11 declarações dos arts. 4º e 5º não conferidas": (G, "            if frag not in vis:", "            if False:"),
    "M12 dígitos do CNPJ não conferidos": (G, "        if nums[size] != (0 if r < 2 else 11 - r):", "        if False:"),
    "M13 REQUIRED sem fiscal aceito": (G, '    if "fiscal" not in req:', "    if False:"),
    "M14 status público sem fiscal aceito": (G, '    if "const open = released && fiscalProcessDefined(fiscal);" not in ctl:', "    if False:"),
    "M15 /api/status sem fiscal aceito": (G, "    if not re.search(r'\"production\" &&\\s*fiscalProcessDefined\\(\\);', compat):", "    if False:"),
    "M16 DEFINIDO incompleto aceito": (G, "            elif not isinstance(v, str) or len(v.strip()) < 2 or PENDING.search(v):", "            elif False:"),
    "M17 NAO_DEFINIDO preenchido aceito": (G, '        if fp.get("decision") is not None:', "        if False:"),
    "M18 checklist incompleto aceito": (G, "        if need not in ids:", "        if False:"),
    "M19 taxas adicionais não conferidas": (G, '        if "sem taxas adicionais" not in r.get("preco_total", ""):', "        if False:"),
    "M20 link para os termos não conferido": (G, "        if not re.search(r'href=\"[^\"]*/termos[#\"]', raw):", "        if False:"),
    "M21 status público abre sem fiscal": (SC, "    const open = released && fiscalProcessDefined(fiscal);", "    const open = released;"),
    "M22 procedimento fiscal sem referência no repositório": (F, '      if (!r || r.kind !== "repo" || !filled(r.ref) || !filled(r.contains)) return false;', "      if (!r) return false;"),
}

ALLOW_FILE = Path(os.environ.get("P23_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p23_legal_allow.json"))


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
