#!/usr/bin/env python3
"""Mutantes causais da leitura de pedidos de PRODUÇÃO somente leitura (R9 B; auditoria Sol 174), classificados pelo
classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação). Mesmo desenho de
scripts/ci/mutants_pilot_removal.py.

Suíte (uma execução `node --test`, TAP): tests/production-order-lookup.test.mjs (L1-L7: Worker real de produção pela sonda
tests/helpers/order-lookup-probe.mjs com e sem o piloto, script real de conciliação pelo harness
tests/helpers/mp_readonly_audit_harness.py, contrato do módulo).
Cada mutante altera UMA regra (worker/internal-financial-audit.mjs, compat ou scripts/mercadopago_readonly_payments_audit.py)
numa cópia mínima da árvore em diretório temporário.
Expectativas em mutants_order_lookup_allow.json (formato load_mutant_config), escritas por raciocínio ANTES de rodar.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_order_lookup.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/production-order-lookup.test.mjs"]
COPY_DIRS = ["worker", "data", "tests/t4_sim", "tests/helpers", ".github/workflows", "scripts", "ops"]
COPY_FILES = TESTS + ["certification-worker.mjs", "admin.css", "wrangler.public-router.toml", "wrangler.sales.toml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"

M = {
    'O1 route not registered': ('worker/internal-financial-audit.mjs', 'if(![ORDER_LOOKUP_PATH,"/api/internal/audit/financial-classification"', 'if(!["/api/internal/audit/financial-classification"'),
    'O2 transaction not read-only': ('worker/internal-financial-audit.mjs', '[parsed.ids.join(",")])],{readOnly:true});', '[parsed.ids.join(",")])],{});'),
    'O3 plain query instead of read-only transaction': ('worker/internal-financial-audit.mjs', '[rows]=await sql.transaction([sql.query(ORDER_LOOKUP_SQL,[parsed.ids.join(",")])],{readOnly:true});', 'rows=await sql.query(ORDER_LOOKUP_SQL,[parsed.ids.join(",")]);'),
    'O4 no read-only transaction precondition': ('worker/internal-financial-audit.mjs', '    if(typeof sql?.transaction!=="function"||typeof sql?.query!=="function")return {code:503,result:{error:"read_only_transaction_unavailable"}};\n', ''),
    'O5 lookup before authentication': ('worker/internal-financial-audit.mjs', '  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});\n', '  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});\n  if(path===ORDER_LOOKUP_PATH){const x=await orderLookup(url,env,sqlFactory);return reply(x.code,x.result);}\n'),
    'O6 write method accepted': ('worker/internal-financial-audit.mjs', '  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});', '  if(false)return reply(405,{error:"method_not_allowed"});'),
    'O7 order id not validated': ('worker/internal-financial-audit.mjs', '  if(!ids.every(id=>ORDER_UUID.test(id)))return {error:"order_id_invalid"};\n', ''),
    'O8 batch size unbounded': ('worker/internal-financial-audit.mjs', '  if(ids.length>ORDER_LOOKUP_MAX)return {error:"order_lookup_limit_exceeded"};\n', ''),
    'O9 compat enriches order lookup': ('worker/cloudflare-worker.compat.mjs', 'audit.status === 200 && url.pathname !== "/api/internal/audit/order-lookup")', 'audit.status === 200)'),
    'O10 script back to the pilot route': ('scripts/mercadopago_readonly_payments_audit.py', 'ORDER_LOOKUP_PATH="/api/internal/audit/order-lookup"', 'ORDER_LOOKUP_PATH="/api/internal/certification/e2e/status"'),
    'O11 script sends non-UUID references': ('scripts/mercadopago_readonly_payments_audit.py', '"ORDER_NOT_VERIFIED" if ORDER_UUID.fullmatch(order_id) else', '"ORDER_NOT_VERIFIED" if order_id else'),
    'O12 production fetch without the pilot view': ('worker/cloudflare-worker.compat.mjs', '    let normalized = normalizeEnv(productionEnvView(env));', '    let normalized = normalizeEnv(env);'),
}

ALLOW_FILE = Path(os.environ.get("ORDER_LOOKUP_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_order_lookup_allow.json"))


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
