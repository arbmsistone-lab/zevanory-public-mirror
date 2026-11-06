#!/usr/bin/env python3
"""Mutantes causais da remoção do piloto de certificação da produção (R9 B, roteiro v4.7; auditoria Sol 164 §4),
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação). Mesmo desenho de
scripts/ci/mutants_credential_separation.py.

Suíte (uma execução `node --test`, TAP): tests/production-pilot-removal.test.mjs (B1-B7: Worker real de produção com o
piloto inteiro ligado pela sonda tests/helpers/pilot-removal-probe.mjs, controles, vista de env, entradas do Worker,
preparador e verificador de deploy reais) e tests/ci/credential-separation-gate.test.mjs (G1-G8, gate real; PyYAML).
Cada mutante altera UMA regra (worker/production-pilot-guard.mjs, compat, prepare-central-candidate.py,
verify-financial-boundary.py ou o gate) numa cópia mínima da árvore em diretório temporário.
Expectativas em mutants_pilot_removal_allow.json (formato load_mutant_config), escritas por raciocínio ANTES de rodar.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_pilot_removal.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/production-pilot-removal.test.mjs", "tests/ci/credential-separation-gate.test.mjs"]
COPY_DIRS = ["worker", "data", "tests/t4_sim", "tests/helpers", ".github/workflows", "scripts", "ops"]
COPY_FILES = TESTS + ["certification-worker.mjs", "admin.css", "wrangler.public-router.toml", "wrangler.sales.toml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"

M = {
    'E1 production fetch without the view': ('worker/cloudflare-worker.compat.mjs', '    let normalized = normalizeEnv(productionEnvView(env));', '    let normalized = normalizeEnv(env);'),
    'E2 scheduled without the view': ('worker/cloudflare-worker.compat.mjs', '  const normalized = normalizeEnv(productionEnvView(env));\n  if (controller?.cron', '  const normalized = normalizeEnv(env);\n  if (controller?.cron'),
    'E3 queue without the view': ('worker/cloudflare-worker.compat.mjs', 'worker.queue(batch, normalizeEnv(productionEnvView(env)), ctx);', 'worker.queue(batch, normalizeEnv(env), ctx);'),
    'E4 email without the view': ('worker/cloudflare-worker.compat.mjs', 'wrapped.email = async (message, env, ctx) => {\n  const normalized = normalizeEnv(productionEnvView(env));', 'wrapped.email = async (message, env, ctx) => {\n  const normalized = normalizeEnv(env);'),
    'V1 runtime config not filtered': ('worker/production-pilot-guard.mjs', '  const runtime = filteredRuntimeConfig(Reflect.get(env, "ZEVANORY_RUNTIME_CONFIG"), hidden);', '  const runtime = Reflect.get(env, "ZEVANORY_RUNTIME_CONFIG");'),
    'V2 process.env leftovers kept': ('worker/production-pilot-guard.mjs', '  if (isCertificationPerimeter(env)) return env;\n  scrubPilotFromProcessEnv();\n', '  if (isCertificationPerimeter(env)) return env;\n'),
    'V3 has() reveals pilot': ('worker/production-pilot-guard.mjs', '    has(_t, prop) { return blocked(prop) ? false : Reflect.has(env, prop); },', '    has(_t, prop) { return Reflect.has(env, prop); },'),
    'V4 ownKeys reveals pilot': ('worker/production-pilot-guard.mjs', '    ownKeys() { return Reflect.ownKeys(env).filter((k) => !blocked(k)); },', '    ownKeys() { return Reflect.ownKeys(env); },'),
    'V5 descriptor reveals pilot': ('worker/production-pilot-guard.mjs', '    getOwnPropertyDescriptor(_t, prop) {\n      if (blocked(prop)) return undefined;\n', '    getOwnPropertyDescriptor(_t, prop) {\n'),
    'V6 perimeter by deployment env only': ('worker/production-pilot-guard.mjs', '  if (isCertificationPerimeter(env)) return env;\n  scrubPilotFromProcessEnv();', '  if (String(env.ZEVANORY_DEPLOYMENT_ENV) === "certification") return env;\n  scrubPilotFromProcessEnv();'),
    'V7 pilot removed from certification too': ('worker/production-pilot-guard.mjs', '  if (isCertificationPerimeter(env)) return env;\n  scrubPilotFromProcessEnv();', '  if (false) return env;\n  scrubPilotFromProcessEnv();'),
    'V8 only ENABLED hidden': ('worker/production-pilot-guard.mjs', 'export const PILOT_NAME = /^CERTIFICATION_PILOT_/;', 'export const PILOT_NAME = /^CERTIFICATION_PILOT_ENABLED$/;'),
    'V9 get reveals pilot': ('worker/production-pilot-guard.mjs', '      if (blocked(prop)) return undefined;\n      if (prop === "ZEVANORY_RUNTIME_CONFIG") return runtime;', '      if (prop === "ZEVANORY_RUNTIME_CONFIG") return runtime;'),
    'D1 preparer writes CERTIFICATION_PILOT_ENV again': ('scripts/deploy/prepare-central-candidate.py', 'c.pop("keep_vars",None)\n', 'c.pop("keep_vars",None)\nc["vars"]["CERTIFICATION_PILOT_ENV"]="sandbox"\n'),
    'D2 preparer keeps inherited pilot vars': ('scripts/deploy/prepare-central-candidate.py', '        _vars.pop(_k)\n', '        pass\n'),
    'D3 preparer keeps keep_vars': ('scripts/deploy/prepare-central-candidate.py', 'c.pop("keep_vars",None)\n', ''),
    'D4 verifier ignores pilot vars': ('scripts/deploy/verify-financial-boundary.py', 'assert not _pilot, "NO_PRODUCTION_PILOT_BINDING:" + ",".join(_pilot)', 'assert True, "NO_PRODUCTION_PILOT_BINDING:" + ",".join(_pilot)'),
    'D5 verifier ignores runtime config pilot': ('scripts/deploy/verify-financial-boundary.py', '_pilot += sorted("ZEVANORY_RUNTIME_CONFIG." + k for k in (_runtime_cfg if isinstance(_runtime_cfg, dict) else {}) if str(k).startswith("CERTIFICATION_PILOT_"))\n', ''),
    'D6 verifier allows keep_vars': ('scripts/deploy/verify-financial-boundary.py', 'assert config.get("keep_vars") is not True, "DASHBOARD_VARS_MUST_NOT_SURVIVE_DEPLOY"', 'assert True, "DASHBOARD_VARS_MUST_NOT_SURVIVE_DEPLOY"'),
    'D7 verifier back to sandbox contract': ('scripts/deploy/verify-financial-boundary.py', 'assert not _pilot, "NO_PRODUCTION_PILOT_BINDING:" + ",".join(_pilot)', 'assert str(vars.get("CERTIFICATION_PILOT_ENV", "")).lower() == "sandbox", "CERTIFICATION_PILOT_MUST_BE_SANDBOX"'),
    'K1 pilot deploy-config exception restored': ('ops/r9-debt.json', '"name": "CERTIFICATION_PILOT_ENV",\n      "kind": "worker_var",\n      "github_secret_exception": false,\n      "deploy_config": false,', '"name": "CERTIFICATION_PILOT_ENV",\n      "kind": "worker_var",\n      "github_secret_exception": false,\n      "deploy_config": true,'),
}

ALLOW_FILE = Path(os.environ.get("PILOT_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_pilot_removal_allow.json"))


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
