#!/usr/bin/env python3
"""Mutantes causais da JANELA DE MIGRAÇÃO da credencial de operador (Sol 233), classificados pelo classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação). Mesmo desenho de scripts/ci/mutants_operator_token.py.

Suíte (uma execução `node --test`, TAP): tests/ci/operator-token-migration.test.mjs (M1-M8: resolvedor, registro por
categoria, Worker real de produção pela sonda tests/helpers/operator-token-migration-probe.mjs, handlers diretos e sonda
HMAC, presença no GitHub com `date` fixo, readback, preparador/verificador de deploy, teto único) e
tests/ci/operator-token-inventory.test.mjs (I1-I7: inventário de consumidores de docs/ops/operator-token-transition.md, prova T2 no Worker de controle e sonda HMAC).
Cada mutante altera UMA regra numa cópia mínima da árvore em diretório temporário (o repositório nunca é alterado).
Expectativas em mutants_operator_token_migration_allow.json (primary com marcador [Xn.k]; secondary com justificativa),
escritas por raciocínio sobre a mutação ANTES de rodá-la.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_operator_token_migration.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/ci/operator-token-migration.test.mjs", "tests/ci/operator-token-inventory.test.mjs"]
COPY_DIRS = ["worker", "data", "tests/t4_sim", "tests/helpers", ".github/workflows", "scripts", "docs/ops"]
COPY_FILES = TESTS + ["certification-worker.mjs", "admin.css"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"

M = {
    'A1 window never accepts legacy': ('worker/operator-credential.mjs', '  if (resolved.source === "primary" && operatorTokenMigration(env, { now }).open) {', '  if (false) {'),
    'A2 window always open': ('worker/operator-credential.mjs', '  if (resolved.source === "primary" && operatorTokenMigration(env, { now }).open) {', '  if (resolved.source === "primary" && (operatorTokenMigration(env, { now }).open || true)) {'),
    'A3 expiry ignored': ('worker/operator-credential.mjs', '  if (now > until) return Object.freeze({ open: false, state: "expired" });\n', ''),
    'A4 code ceiling ignored': ('worker/operator-credential.mjs', '  if (value > MIGRATION_CODE_CEILING) return Object.freeze({ open: false, state: "beyond_code_ceiling" });\n', ''),
    'A5 window closes at the start of the day': ('worker/operator-credential.mjs', 'const t = Date.parse(day + "T23:59:59.999Z");', 'const t = Date.parse(day + "T00:00:00.000Z");'),
    'A6 impossible calendar date accepted': ('worker/operator-credential.mjs', '  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? t : NaN;', '  return t;'),
    'A7 any value accepted as legacy in the window': ('worker/operator-credential.mjs', '    const ok = c.token.length >= minLength && constantTimeEqual(c.token, provided);', '    const ok = c.token.length >= minLength && (constantTimeEqual(c.token, provided) || c.category === "legacy");'),
    'A8 consumer minimum length ignored': ('worker/operator-credential.mjs', '    const ok = c.token.length >= minLength && constantTimeEqual(c.token, provided);', '    const ok = constantTimeEqual(c.token, provided);'),
    'A9 presented value logged': ('worker/operator-credential.mjs', '  recordOperatorAuth(hit || "none", { log });\n  return hit;', '  recordOperatorAuth(hit || "none", { log });\n  try { log?.info?.call(log, "operator_token_auth_debug", text(provided)); } catch {}\n  return hit;'),
    'A10 signed probe checks only the primary': ('worker/signed-audit-probe.mjs', '  for(const c of operatorCredentialCandidates(env,{now})){', '  for(const c of operatorCredentialCandidates(env,{now}).slice(0,1)){'),
    'A11 audit route bypasses the window': ('worker/internal-financial-audit.mjs', '  return verifyOperatorToken(env,String(request.headers.get("x-certification-e2e-token")||""),{minLength:32});', '  return verifyOperatorToken({...env,OPERATOR_TOKEN_MIGRATION_UNTIL:"",ZEVANORY_RUNTIME_CONFIG:{}},String(request.headers.get("x-certification-e2e-token")||""),{minLength:32});'),
    'A12 readback hides the presented category': ('worker/internal-financial-audit.mjs', '    operator_token_presented:presented||"none",', '    operator_token_presented:"primary",'),
    'G1 presence ignores the window': ('scripts/ci/operator-token-github-presence.sh', 'if [ "$eq" = false ] && [ "$window" = open ]; then', 'if false; then'),
    'G2 presence ignores expiry': ('scripts/ci/operator-token-github-presence.sh', '  elif [[ "$today" > "$mig" ]]; then window=expired', '  elif false; then window=expired'),
    'G3 presence ignores the code ceiling': ('scripts/ci/operator-token-github-presence.sh', '  if [[ "$mig" > "$MIGRATION_CODE_CEILING" ]]; then window=beyond_code_ceiling', '  if false; then window=beyond_code_ceiling'),
    'G4 presence drops require_primary': ('scripts/ci/operator-token-github-presence.sh', 'if [ "${REQUIRE_PRIMARY:-false}" = "true" ] && [ "$n" != present ]; then', 'if false; then'),
    'G5 presence accepts malformed dates': ('scripts/ci/operator-token-github-presence.sh', 'elif [[ "$mig" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [ "$(date -u -d "$mig" +%F 2>/dev/null || true)" = "$mig" ]; then', 'elif true; then'),
    'R1 readback ignores the presented category': ('scripts/ci/credential_identity_readback.py', '    if require_primary and out["OPERATOR_TOKEN_PRESENTED"] != "primary":\n        reasons.append("RUNNER_TOKEN_NOT_PRIMARY")\n', ''),
    'R2 readback echoes the raw presented field': ('scripts/ci/credential_identity_readback.py', '    out["OPERATOR_TOKEN_PRESENTED"] = presented if presented in PRESENTED else "unverified"', '    out["OPERATOR_TOKEN_PRESENTED"] = str(presented)'),
    'D1 deploy writes the flag as its own var': ('scripts/deploy/prepare-central-candidate.py', '    c["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG",{})["OPERATOR_TOKEN_MIGRATION_UNTIL"]=_mig', '    c["vars"]["OPERATOR_TOKEN_MIGRATION_UNTIL"]=_mig'),
    'D2 deploy accepts a flag beyond the ceiling': ('scripts/deploy/prepare-central-candidate.py', '    if not _ok or _mig>OPERATOR_TOKEN_MIGRATION_CODE_CEILING:', '    if not _ok:'),
    'D3 deploy keeps an inherited flag': ('scripts/deploy/prepare-central-candidate.py', 'for _vars in (c["vars"], _rc if isinstance(_rc,dict) else {}):\n    _vars.pop("OPERATOR_TOKEN_MIGRATION_UNTIL",None)\n', ''),
    'D4 verifier allows the flag as its own var': ('scripts/deploy/verify-financial-boundary.py', 'assert "OPERATOR_TOKEN_MIGRATION_UNTIL" not in vars, "OPERATOR_TOKEN_MIGRATION_ONLY_IN_RUNTIME_CONFIG"\n', ''),
    'D5 verifier allows a flag beyond the ceiling': ('scripts/deploy/verify-financial-boundary.py', ' and _mig <= "2026-12-31", "OPERATOR_TOKEN_MIGRATION_UNTIL_INVALID"', ', "OPERATOR_TOKEN_MIGRATION_UNTIL_INVALID"'),
    'V1 inventory drops a production consumer': ('docs/ops/operator-token-transition.md', '    {"workflow": "data-backup.yml", "job": "backup", "environment": "gh-pages-automacao", "form": "new+fallback", "trigger": "schedule 10 5 * * * + dispatch", "uses": "POST /api/internal/backup/run (scripts/ops/data-backup.mjs)", "read_only": false},\n', ''),
    'V2 proof matrix drops a consumer': ('.github/workflows/operator-token-consumer-auth.yml', '          - "data-backup.yml#backup"\n', ''),
    'V3 new script reads the credential': ('scripts/zero_cost_guard.py', '#!/usr/bin/env python3\n', '#!/usr/bin/env python3\n# ZEVANORY_OPERATOR_TOKEN\n'),
    'V4 new Worker module imports the resolver': ('worker/data-backup.mjs', 'export function tokenOk(provided, expected) {', 'import { operatorToken as _unusedOperatorToken } from "./operator-credential.mjs";\nexport function tokenOk(provided, expected) {'),
    'V5 proof falls back to the legacy secret': ('.github/workflows/operator-token-consumer-auth.yml', 'secrets.ZEVANORY_OPERATOR_TOKEN }}\n      PYTHONDONTWRITEBYTECODE: "1"\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n      - name: Read-only proof that the new credential authenticates as primary\n        shell: bash\n        env:\n          CONSUMER: ${{ matrix.consumer }}\n        run: |\n          set -euo pipefail\n          echo "CONSUMER=$CONSUMER ENVIRONMENT=producao-critica"', 'secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN }}\n      PYTHONDONTWRITEBYTECODE: "1"\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n      - name: Read-only proof that the new credential authenticates as primary\n        shell: bash\n        env:\n          CONSUMER: ${{ matrix.consumer }}\n        run: |\n          set -euo pipefail\n          echo "CONSUMER=$CONSUMER ENVIRONMENT=producao-critica"'),
    'V6 proof without require-primary': ('.github/workflows/operator-token-consumer-auth.yml', 'echo "CONSUMER=$CONSUMER ENVIRONMENT=producao-critica"\n          python3 scripts/ci/credential_identity_readback.py https://zevanory.api.br --require-primary', 'echo "CONSUMER=$CONSUMER ENVIRONMENT=producao-critica"\n          python3 scripts/ci/credential_identity_readback.py https://zevanory.api.br'),
    'V7 T2 HMAC proof falls back to the legacy secret': ('.github/workflows/operator-token-consumer-auth.yml', '    env:\n      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN }}\n    steps:', '    env:\n      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN }}\n    steps:'),
    'V8 T2 HMAC proof drops a T2 caller': ('.github/workflows/operator-token-consumer-auth.yml', '          - "t2-workers-ai-creative-factory.yml#generate"\n    env:\n      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN }}\n    steps:', '    env:\n      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN }}\n    steps:'),
    'V9 T2 HMAC proof without require-primary': ('.github/workflows/operator-token-consumer-auth.yml', 'node scripts/ci/control_edge_hmac_probe.mjs --require-primary', 'node scripts/ci/control_edge_hmac_probe.mjs'),
    'P1 HMAC probe accepts a non-primary category': ('scripts/ci/control_edge_hmac_probe.mjs', '  if (requirePrimary && out.CATEGORY !== "primary") return', '  if (false) return'),
    'P2 HMAC probe sends the credential to any origin': ('scripts/ci/control_edge_hmac_probe.mjs', '  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o)) return o;', '  return o;'),
}

ALLOW_FILE = Path(os.environ.get("OPERATOR_TOKEN_MIGRATION_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_operator_token_migration_allow.json"))


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
