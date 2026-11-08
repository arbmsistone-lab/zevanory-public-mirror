#!/usr/bin/env python3
"""Mutantes causais do diário de eventos críticos P20 no D1 (worker/diario-p20.mjs + migrations/d1/0001_diario_v1.sql),
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p20-diario-d1.test.mjs (DJ1-DJ8), com D1 falso que executa SQL de
verdade (node:sqlite) aplicando a migração real. Sem rede, sem Cloudflare, sem segredos. Cada mutante altera UMA regra
numa cópia mínima da árvore em diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p20_diario_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [DJn.k] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida,
primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p20_diario.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p20-diario-d1.test.mjs"]
COPY_DIRS = ["migrations/d1"]
# worker/diario-sombra.mjs e worker/diario-reconcilia.mjs: DJ8.7 confere que são os ÚNICOS importadores do módulo puro
# (PR 3 e PR 4), e DJ8.8 que a reconciliação só importa verifyChain.
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/helpers/d1-sqlite.mjs", "worker/diario-p20.mjs", "worker/diario-sombra.mjs", "worker/diario-reconcilia.mjs"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
J, S = "worker/diario-p20.mjs", "migrations/d1/0001_diario_v1.sql"

M = {
    "M01 prev_hash fora do hash encadeado": (J, "[DIARIO_SCHEMA, prevHash, eventKeyValue, payloadShaValue, String(tsMs)]", "[DIARIO_SCHEMA, eventKeyValue, payloadShaValue, String(tsMs)]"),
    "M02 conflito de event_key aceito como duplicada": (J, "        return { ok: false, code: \"diario_conflito\" };\n", "        return { ok: true, duplicate: true };\n"),
    "M03 resultado do compare-and-set ignorado": (J, "      if (changesOf(res?.[0]) === 1 && changesOf(res?.[1]) === 1) return {", "      return {"),
    "M04 assertNoPii desligado": (J, "  walk(payload, \"$\", 0);\n  return true;\n", "  return true;\n"),
    "M05 trigger que proíbe UPDATE removido": (S, "CREATE TRIGGER IF NOT EXISTS diario_v1_sem_update\nBEFORE UPDATE ON diario_v1\nBEGIN\n  SELECT RAISE(ABORT, 'diario_v1_somente_inclusao');\nEND;\n", ""),
    "M06 verifyChain sempre ok": (J, "export async function verifyChain(rows, opts = {}) {\n", "export async function verifyChain(rows, opts = {}) {\n  return { ok: true, broken_at: null, count: rows.length, head: null };\n"),
    "M07 trigger que proíbe DELETE removido": (S, "CREATE TRIGGER IF NOT EXISTS diario_v1_sem_delete\nBEFORE DELETE ON diario_v1\nBEGIN\n  SELECT RAISE(ABORT, 'diario_v1_somente_inclusao');\nEND;\n", ""),
    "M08 uma tentativa só em corrida": (J, "export const MAX_TENTATIVAS = 3;", "export const MAX_TENTATIVAS = 1;"),
    "M09 CPF não detectado": (J, "  if (RE_CPF.test(s)) return \"cpf\";\n", ""),
    "M10 verifyChain não confere payload_sha": (J, "    if ((await sha256Hex(r.payload_json)) !== r.payload_sha) return bad(\"payload_sha\");\n", ""),
}

ALLOW_FILE = Path(os.environ.get("P20_DIARIO_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p20_diario_allow.json"))


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
    return mc.run_command([NODE, "--test", "--test-concurrency=1", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
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
