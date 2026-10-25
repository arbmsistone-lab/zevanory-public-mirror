#!/usr/bin/env python3
"""Mutantes causais da medição P19 (Workers e Neon) no coletor B0 (scripts/b0/*) e na leitura somente leitura de uso de
Workers (scripts/audit/workers-usage.mjs), classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py
(sem modificação).

Suíte (uma execução `node --test`, TAP): tests/b0-baseline.test.mjs (B0, P19 Workers/Neon, margens). Sem rede, sem
segredos. Cada mutante altera UMA regra numa cópia mínima da árvore em
diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p19_capacity_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [P19x.k] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida,
primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p19_capacity.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/b0-baseline.test.mjs"]
COPY_DIRS = ["scripts/b0", "docs/b0", "scripts/p20", "docs/p20"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/helpers/p20-backup-fixture.mjs", "scripts/audit/workers-usage.mjs", ".github/workflows/b0-baseline-collector.yml",
                      ".github/workflows/p18-external-monitor.yml", ".github/workflows/b0-baseline-tests.yml", ".github/workflows/p18-monitor-watchdog.yml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
WU, B, C = "scripts/audit/workers-usage.mjs", "scripts/b0/b0-lib.mjs", "scripts/b0/b0-collector.mjs"

M = {
    "N01 requisições não somadas por Worker": (WU, "    s.requests += req;", "    s.requests = req;"),
    "N02 CPU p99 pelo melhor Worker": (WU, "(s.cpu_p99_ms > w.ms ? { ms: s.cpu_p99_ms, script: n } : w)", "(s.cpu_p99_ms < w.ms ? { ms: s.cpu_p99_ms, script: n } : w)"),
    "N03 CPU sem conversão µs -> ms": (WU, "    s.cpu_p99_ms = Math.max(s.cpu_p99_ms, Math.round(p99 / 10) / 100);", "    s.cpu_p99_ms = Math.max(s.cpu_p99_ms, p99);"),
    "N04 grupo com requisições negativas aceito": (WU, "!Number.isInteger(req) || req < 0 ||", "!Number.isInteger(req) ||"),
    "N05 lista vazia vira zero requisições": (WU, "  if (groups.length === 0) return { verified: false, day, reason: \"no_groups\" };\n", ""),
    "N06 janela da consulta de dois dias": (WU, "e: new Date(Date.parse(day + \"T00:00:00Z\") + 86400000)", "e: new Date(Date.parse(day + \"T00:00:00Z\") + 2 * 86400000)"),
    "N07 workersUsage de outro dia aceito": (B, "  if (w.day !== day) return { ok: false, reason: \"workers_usage_other_day\" };\n", ""),
    "N08 workersUsage não verificado sem motivo próprio": (B, "  if (w.verified !== true) return { ok: false, reason: \"workers_usage_unverified:\" + String(w.reason || \"\").slice(0, 60) };\n", ""),
    "N09 pct incoerente aceito": (B, "\n    && Math.abs(v.pct - Math.round(v.requests / v.limit * 1000) / 10) < 0.051", ""),
    "N10 PLAN_PROBE antigo aceito": (B, "  if (age > P19_NEON_STORAGE_MAX_AGE_DAYS) return { ok: false, reason: \"plan_probe_too_old\" };\n", ""),
    "N11 falha de conexão do Neon ignorada": (B, "  if (Array.isArray(j.v.notVerifiable) && j.v.notVerifiable.some((x) => isObj(x) && x.provider === \"neon\")) return { ok: false, reason: \"plan_probe_neon_connection_failed\" };\n", ""),
    "N12 limite do Neon de 1 GB": (B, "export const NEON_FREE_BYTES = 512 * 1024 * 1024;", "export const NEON_FREE_BYTES = 1024 * 1024 * 1024;"),
    "N13 Workers do dia D lidos do run do próprio dia": (C, "    const next = addDays(day, 1);", "    const next = day;"),
    "N14 margem pelo melhor dia": (B, "(!w || x.used / x.limit > w.used / w.limit ? x : w)", "(!w || x.used / x.limit < w.used / w.limit ? x : w)"),
    "N15 meta avaliada com menos de 7 dias": (B, "      within_target: vals.length >= 7 ?", "      within_target: vals.length >= 1 ?"),
    "N16 NOT_AVAILABLE entra na margem": (B, "if (fieldOk(res.field, f)) vals.push(", "if (f && f.value) vals.push("),
    "N17 flag complete forjada aceita": (B, "    if (e.complete === true && !presentOk) throw new Error(\"complete_flag_mismatch \" + pid);", "    if (false) throw new Error(\"complete_flag_mismatch \" + pid);"),
    "N18 Neon CU-h declarado presente": (B, "      { id: \"neon_compute_readonly\", status: \"MISSING\",", "      { id: \"neon_compute_readonly\", status: \"PRESENT\","),
    "N19 Workers com requisições ociosas no pior p99": (WU, "  const list = Object.entries(scripts).filter(([, s]) => s.requests > 0);", "  const list = Object.entries(scripts);"),
    "N20 consulta sem token aceita": (WU, "  if (!token || !account) return { verified: false, day, reason: \"token_or_account_missing\" };\n", ""),
}

ALLOW_FILE = Path(os.environ.get("P19_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p19_capacity_allow.json"))


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
