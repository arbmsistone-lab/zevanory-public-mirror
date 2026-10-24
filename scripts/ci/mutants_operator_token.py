#!/usr/bin/env python3
"""Mutantes causais da migração da credencial de operador (R9, roteiro v4.7; auditoria Sol 164 §4), classificados pelo
classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação). Mesmo desenho de
scripts/ci/mutants_credential_separation.py (F2 item 9).

Suíte (uma execução `node --test`, TAP): tests/operator-token-transition.test.mjs (T1-T5: resolvedor, Worker real de
produção pela sonda tests/helpers/operator-token-probe.mjs, handlers diretos, perímetro de certificação, readback) e
tests/ci/operator-token-gate.test.mjs (K1-K7: gate scripts/ci/operator_token_gate.py, readback
scripts/ci/credential_identity_readback.py e scripts/ci/operator-token-github-presence.sh executados de verdade).
Cada mutante altera UMA regra (worker/*.mjs, certification-worker.mjs, gate, readback ou presença) numa cópia mínima da
árvore em diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_operator_token_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Xn.k]) e secondary com justification, escritas por raciocínio sobre a mutação ANTES
de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary sem marcador, test_pattern que não
casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_operator_token.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/operator-token-transition.test.mjs", "tests/ci/operator-token-gate.test.mjs"]
COPY_DIRS = ["worker", "data", "tests/t4_sim", "tests/helpers", ".github/workflows", "scripts"]
COPY_FILES = TESTS + ["certification-worker.mjs", "admin.css"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"

M = {
    'O1 legacy preferred over new': ('worker/operator-credential.mjs', '  const primary = text(env[OPERATOR_TOKEN_NAME]);\n  if (primary) return Object.freeze({ token: primary, source: "primary" });\n  if (OPERATOR_TOKEN_LEGACY_FALLBACK) {', '  const primary = text(env[OPERATOR_TOKEN_NAME]);\n  if (primary && !text(env[LEGACY_OPERATOR_TOKEN_NAME])) return Object.freeze({ token: primary, source: "primary" });\n  if (OPERATOR_TOKEN_LEGACY_FALLBACK) {'),
    'O2 short new token falls back to legacy': ('worker/operator-credential.mjs', '  if (primary) return Object.freeze({ token: primary, source: "primary" });', '  if (primary.length >= 32) return Object.freeze({ token: primary, source: "primary" });'),
    'O3 fallback disabled during transition': ('worker/operator-credential.mjs', 'export const OPERATOR_TOKEN_LEGACY_FALLBACK = true;', 'export const OPERATOR_TOKEN_LEGACY_FALLBACK = false;'),
    'O4 fallback log leaks the value': ('worker/operator-credential.mjs', 'JSON.stringify({ category: "legacy_fallback", name: LEGACY_OPERATOR_TOKEN_NAME, expected: OPERATOR_TOKEN_NAME })', 'JSON.stringify({ category: "legacy_fallback", name: LEGACY_OPERATOR_TOKEN_NAME, expected: OPERATOR_TOKEN_NAME, value: legacy })'),
    'O5 perimeter ignores production-only names': ('worker/operator-credential.mjs', '  return PRODUCTION_ONLY_NAMES.every((name) => !present(env, name));', '  return true;'),
    'O6 perimeter ignores worker name': ('worker/operator-credential.mjs', '  if (text(env.CERTIFICATION_WORKER_NAME) !== "zevanory-certification") return false;\n', ''),
    'W1 compat backup reads legacy name': ('worker/cloudflare-worker.compat.mjs', 'operatorCredential(normalized))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });\n      const parts = Math.min(6', 'normalized.CERTIFICATION_E2E_TOKEN)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });\n      const parts = Math.min(6'),
    'W2 compat invite reads legacy name': ('worker/cloudflare-worker.compat.mjs', 'const expected = String(operatorCredential(normalized) || "");', 'const expected = String(normalized.CERTIFICATION_E2E_TOKEN || "");'),
    'W3 recovered telegram proof reads legacy name': ('worker/cloudflare-worker.recovered.mjs', 'url.pathname === "/api/internal/channels/telegram-proof") {\n      const expected = String(operatorCredential(env) || operatorCredential(process.env) || "")', 'url.pathname === "/api/internal/channels/telegram-proof") {\n      const expected = String(env.CERTIFICATION_E2E_TOKEN || process.env.CERTIFICATION_E2E_TOKEN || "")'),
    'W4 recovered node e2e status reads legacy name': ('worker/cloudflare-worker.recovered.mjs', 'const expected = String(operatorCredential(process.env) || process.env.OPERATOR_TOKEN || "");', 'const expected = String(process.env.CERTIFICATION_E2E_TOKEN || process.env.OPERATOR_TOKEN || "");'),
    'W5 internal audit reads legacy name': ('worker/internal-financial-audit.mjs', 'const expected=String(operatorCredential(env)||"");', 'const expected=String(env.CERTIFICATION_E2E_TOKEN||"");'),
    'W6 signed probe reads legacy name': ('worker/signed-audit-probe.mjs', 'const secret=String(operatorCredential(env)||"");', 'const secret=String(env?.CERTIFICATION_E2E_TOKEN||"");'),
    'W7 voice audit reads legacy name': ('worker/voice-chunks.mjs', 'const expected=String(operatorCredential(env)||env.OPERATOR_TOKEN||"");', 'const expected=String(env.CERTIFICATION_E2E_TOKEN||env.OPERATOR_TOKEN||"");'),
    'W8 compat voice audit reads legacy name': ('worker/cloudflare-worker.compat.mjs', 'const expected = String(operatorCredential(normalized) || normalized.OPERATOR_TOKEN || "");', 'const expected = String(normalized.CERTIFICATION_E2E_TOKEN || normalized.OPERATOR_TOKEN || "");'),
    'W9 post-sale certification reads legacy name': ('worker/post-sale.mjs', 'const cert = String(operatorCredential(env) || "");', 'const cert = String(env.CERTIFICATION_E2E_TOKEN || "");'),
    'W10 refund approve reads legacy name': ('worker/refund-flow.mjs', 'const expected = String(operatorCredential(env) || "");', 'const expected = String(env.CERTIFICATION_E2E_TOKEN || "");'),
    'W11 certification worker accepts production operator token': ('certification-worker.mjs', '"RESEND_API_KEY","ASAAS_API_KEY","ZEVANORY_OPERATOR_TOKEN","SELF","CORE"]', '"RESEND_API_KEY","ASAAS_API_KEY","SELF","CORE"]'),
    'W12 stripe test key reported as live': ('worker/internal-financial-audit.mjs', '  if(/^(?:sk|rk)_live_/.test(v))return "live";\n  if(/^(?:sk|rk)_test_/.test(v))return "test";', '  if(/^(?:sk|rk)_(?:live|test)_/.test(v))return "live";'),
    'W13 credential identity leaks token': ('worker/internal-financial-audit.mjs', '    stripe_key_mode:stripeKeyMode(env?.STRIPE_SECRET_KEY),', '    stripe_key_mode:stripeKeyMode(env?.STRIPE_SECRET_KEY),operator_token:operatorCredential(env),'),
    'W14 credential identity unauthenticated': ('worker/internal-financial-audit.mjs', '  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});\n  if(!(await authorized(request,env))', '  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});\n  if(path.endsWith("/credential-identity"))return reply(200,credentialIdentity(env));\n  if(!(await authorized(request,env))'),
    'K1 gate accepts legacy before new': ('scripts/ci/operator_token_gate.py', 'FALLBACK_FORM = re.compile(r"\\bsecrets\\s*\\.\\s*" + NEW + r"\\s*\\|\\|\\s*secrets\\s*\\.\\s*" + LEGACY + r"\\b")', 'FALLBACK_FORM = re.compile(r"\\bsecrets\\s*\\.\\s*(?:" + NEW + "|" + LEGACY + r")\\s*\\|\\|\\s*secrets\\s*\\.\\s*(?:" + NEW + "|" + LEGACY + r")\\b")'),
    'K2 gate never treats a job as retired': ('scripts/ci/operator_token_gate.py', '    return cond is False or (isinstance(cond, str) and bool(DISABLED_IF.match(cond)))', '    return False'),
    'K3 gate skips sandbox check for production token': ('scripts/ci/operator_token_gate.py', '            if NEW_SECRET.search(joined) or any(NEW in b for b in env_blocks(doc, job)):', '            if False:'),
    'K4 gate counts name mentions as reads': ('scripts/ci/operator_token_gate.py', '            if f.is_file() and LEGACY_RUN_READ.search(f.read_text(encoding="utf-8", errors="replace")):', '            if f.is_file() and LEGACY in f.read_text(encoding="utf-8", errors="replace"):'),
    'K5 gate ignores step env': ('scripts/ci/operator_token_gate.py', '    for step in job.get("steps") or []:\n        if isinstance(step, dict) and isinstance(step.get("env"), dict):\n            blocks.append(step["env"])\n', ''),
    'K6 gate ignores shell reads': ('scripts/ci/operator_token_gate.py', 'LEGACY_RUN_READ = re.compile(r"\\$\\{?" + LEGACY + r"\\b|environ', 'LEGACY_RUN_READ = re.compile(r"NEVER_MATCH_PREFIX" + LEGACY + r"\\b|environ'),
    'K7 gate skips worker scan': ('scripts/ci/operator_token_gate.py', '        if LEGACY in text:\n            out.append({"workflow": rel, "job": "-", "environment": "worker", "rule": "WORKER_READS_LEGACY",', '        if False:\n            out.append({"workflow": rel, "job": "-", "environment": "worker", "rule": "WORKER_READS_LEGACY",'),
    'K8 strict ignores resolver flag': ('scripts/ci/operator_token_gate.py', '            if strict and not re.search(r"export const OPERATOR_TOKEN_LEGACY_FALLBACK = false;", text):', '            if False:'),
    'K9 strict ignores workflow fallback': ('scripts/ci/operator_token_gate.py', '        if strict:\n            if LEGACY_SECRET.search(joined):', '        if strict:\n            if False:'),
    'R1 readback accepts stripe test key': ('scripts/ci/credential_identity_readback.py', 'STRIPE_ALLOWED = {"live", "absent"}', 'STRIPE_ALLOWED = {"live", "absent", "test"}'),
    'R2 readback echoes unknown stripe mode': ('scripts/ci/credential_identity_readback.py', '    out["STRIPE_KEY_MODE"] = mode if mode in STRIPE_MODES else "unverified"', '    out["STRIPE_KEY_MODE"] = str(mode)'),
    'R3 readback ignores perimeter': ('scripts/ci/credential_identity_readback.py', '    if out["CERTIFICATION_PERIMETER"] != "false":\n        reasons.append("PRODUCTION_PERIMETER_UNPROVEN")\n', ''),
    'R4 readback ignores require-primary': ('scripts/ci/credential_identity_readback.py', '    if require_primary and out["OPERATOR_TOKEN_SOURCE"] != "primary":', '    if False:'),
    'P1 presence never detects mismatch': ('scripts/ci/operator-token-github-presence.sh', '  if [ "$new" = "$legacy" ]; then eq=true; else eq=false; fi', '  eq=true'),
}

ALLOW_FILE = Path(os.environ.get("OPERATOR_TOKEN_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_operator_token_allow.json"))


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
