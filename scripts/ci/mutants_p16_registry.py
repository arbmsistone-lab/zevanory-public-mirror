#!/usr/bin/env python3
"""Mutantes causais do gate P16 Experimentos (scripts/p16/experiment_registry_gate.py) e do avaliador que respeita o
fechamento (scripts/audit/experiments.mjs), classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py
(sem modificação). Mesmo executor do scripts/ci/mutants_p16_lifecycle.py (#916).

Suíte (uma execução `node --test`, TAP): tests/p16-experiment-registry.test.mjs (T1-T25), que roda o gate real com
python3 -I sobre raízes temporárias (sem rede, sem segredo). Cada mutante altera UMA regra numa cópia mínima da árvore em
diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p16_registry_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Tn.k] da asserção que codifica a regra) e secondary com justification, escritas
por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary
sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p16_registry.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p16-experiment-registry.test.mjs"]
COPY_DIRS = []
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/helpers/toolchain.mjs", "scripts/p16/experiment_registry_gate.py", "scripts/audit/experiments.mjs", "data/experiments.json",
                      "data/p16/experiments.json"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
G = "scripts/p16/experiment_registry_gate.py"
E = "scripts/audit/experiments.mjs"

M = {
    "M01 legado fora da lista fechada aceito": (G, "        if key not in LEGACY_KEYS:\n", "        if False:\n"),
    "M02 A/B sem cálculo amostral aceito": (G, '        errs.append(f"{where}: A/B sem cálculo amostral (sample_size ausente)")\n', "        pass\n"),
    "M03 n declarado não é recalculado": (G, "        if n_decl != n_calc:", "        if False:"),
    "M04 mínimo por braço abaixo do n aceito": (G, "    if not _int(min_n) or (_int(n_decl) and min_n < n_decl):", "    if not _int(min_n):"),
    "M05 início antes do registro aceito": (G, "and st and reg and st < reg:", "and st and reg and st < reg and False:"),
    "M06 mínimo do registro vivo não conferido": (G, 'live_min < pre["min_n_per_arm"])', "live_min < 0)"),
    "M07 aberto vencido aceito": (G, "(today - d).days > mx", "False"),
    "M08 tabela de decisão ignorada": (G, "    if table.get(result) != outcome:", "    if False:"),
    "M09 decisão com n abaixo do mínimo": (G, '        if short and result != "AMOSTRA_INSUFICIENTE":', "        if False:"),
    "M10 diferença sem p < alfa": (G, "and not p < alpha:", "and False:"),
    "M11 janela mínima ignorada": (G, "(closed - st).days < mn", "False"),
    "M12 fechamento sem decisão aceito": (G, "    if outcome not in OUTCOMES:\n", "    if False:\n"),
    "M13 tabela decide com amostra insuficiente": (G, '        if table.get("AMOSTRA_INSUFICIENTE") != "INCONCLUSIVO":', "        if False:"),
    "M14 legado pode decidir": (G, '        if result != LEGACY_RESULT or outcome != "INCONCLUSIVO":', "        if result != LEGACY_RESULT:"),
    "M15 fechado segue aberto no registro vivo": (G, "            if not isinstance(mark, dict) or any(mark.get(k) != v for k, v in want.items()):", "            if False:"),
    "M16 registro alterado em relação à base aceito": (G, '                elif cur[rid].get("record_sha256") != r.get("record_sha256"):', "                elif False:"),
    "M17 record_sha256 não conferido": (G, '        if rec.get("record_sha256") != record_hash(rec):', "        if False:"),
    "M18 divergência com o P02 aceita": (G, '            elif d.get("outcome") != outcome:', "            elif False:"),
    "M19 cálculo amostral sem o poder": (G, "    z_b = norm_ppf(power)", "    z_b = 0.0"),
    "M20 métrica por abertura aceita": (G, '    elif re.search(r"\\babert"', '    elif False and re.search(r"\\babert"'),
    "M21 avaliador reavalia fechado": (E, "    if (exp.closed) return", "    if (false) return"),
    "M23 tabela reconstruída tratada como normativa": (G, '    if table_status != TABLE_CONFIRMED and outcome != "INCONCLUSIVO":', "    if False:"),
    "M24 equivalência afirmada sem TOST": (G, "    if result != EQUIVALENT and EQUIV_WORDS.search(", "    if False and EQUIV_WORDS.search("),
    "M25 EQUIVALENTE sem TOST pré-registrado": (G, '    if result == EQUIVALENT and pre.get("equivalence_test") is None:', "    if False:"),
    "M26 TOST sem p < alfa": (G, 'and not (tost["p_lower"] < eq["alpha"] and tost["p_upper"] < eq["alpha"]):', "and False:"),
    "M27 justificativa da amostra não exigida": (G, '    if not isinstance(rec.get("sample_justification"), str) or len(rec["sample_justification"].strip()) < 30:', "    if False:"),
    "M28 MDE sem justificativa": (G, '    if not isinstance(ss, dict) or not isinstance(ss.get("mde_rationale"), str) or len(ss["mde_rationale"].strip()) < 20:', "    if False:"),
    "M29 regra de parada sem base amostral": (G, '        if stop.get("basis") != "AMOSTRA" or stop.get("min_n_per_arm") != rec.get("min_n_per_arm"):', "        if False:"),
    "M30 base do git ignorada": (G, "            base = json.loads(shown.stdout)", '            base = {"preregistrations": [], "starts": [], "closures": []}'),
    "M31 confirmação da tabela sem referência": (G, '        if not check_ref(root, src.get("confirmation_ref"), "decision_table_source.confirmation_ref", errs):', "        if False:"),
    "M22 registro vivo sem pré-registro aceito": (G, '            errs.append(f"{where}: experimento sem pré-registro em data/p16/experiments.json (nada começa sem registro prévio)")\n', "            pass\n"),
}

ALLOW_FILE = Path(os.environ.get("P16_REGISTRY_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p16_registry_allow.json"))


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
