#!/usr/bin/env python3
"""Mutantes causais da separação de credenciais sandbox x produção (F2 item 9; roteiro 3.1 seção 7), classificados pelo
classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/production-payment-credential-isolation.test.mjs (P1-P7, Worker real),
tests/production-secret-names.test.mjs (N1-N6) e tests/ci/credential-separation-gate.test.mjs (G1-G8, gate real em
python3 + PyYAML). Cada mutante altera UMA regra do código de produção (worker/*.mjs, certification-worker.mjs), do gate
(scripts/ci/credential_separation_gate.py) ou do readback/remoção (scripts/ci/production-secret-names.mjs), numa cópia
mínima da árvore em diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_credential_separation_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Xn.k] da asserção que codifica a regra) e secondary com justification, escritas
por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary
sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_credential_separation.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/production-payment-credential-isolation.test.mjs", "tests/production-secret-names.test.mjs",
         "tests/ci/credential-separation-gate.test.mjs"]
COPY_DIRS = ["worker", "data", "tests/t4_sim", "tests/helpers", ".github/workflows"]
COPY_FILES = TESTS + ["certification-worker.mjs", "admin.css", "ops/r9-debt.json", "scripts/ci/credential_separation_gate.py",
                      "scripts/ci/production-secret-names.mjs", "scripts/deploy/prepare-central-candidate.py",
                      "wrangler.public-router.toml", "wrangler.sales.toml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
R = "worker/cloudflare-worker.recovered.mjs"
C = "worker/cloudflare-worker.compat.mjs"
W = "certification-worker.mjs"
G = "scripts/ci/credential_separation_gate.py"
S = "scripts/ci/production-secret-names.mjs"

M = {
    # Worker de produção / certificação: escolha de credencial
    "W1 production webhook verified with TEST secret": (R, 'webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });', 'webhookSecret: process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });'),
    "W2 production webhook falls back to TEST token": (R, 'accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });', 'accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADOPAGO_TEST_ACCESS_TOKEN, webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });'),
    "W3 test webhook falls back to PRODUCTION token": (R, "accessToken: process.env.MERCADOPAGO_TEST_ACCESS_TOKEN, webhookSecret", "accessToken: process.env.MERCADOPAGO_TEST_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN, webhookSecret"),
    "W4 test webhook verified with PRODUCTION secret": (R, "webhookSecret: process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET, certificationOnly: true", "webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: true"),
    "W5 test webhook not marked as test": (R, 'certificationOnly: true, source: "mercadopago-test"', 'certificationOnly: false, source: "mercadopago-test"'),
    "W6 checkout readiness accepts TEST credentials": (R, 'if (!present2(env.MERCADOPAGO_ACCESS_TOKEN) || !present2(env.MERCADOPAGO_WEBHOOK_SECRET)) local.push("mercadopago_credentials_missing");', 'if (!present2(env.MERCADOPAGO_ACCESS_TOKEN || env.MERCADOPAGO_TEST_ACCESS_TOKEN) || !present2(env.MERCADOPAGO_WEBHOOK_SECRET || env.MERCADOPAGO_TEST_WEBHOOK_SECRET)) local.push("mercadopago_credentials_missing");'),
    "W7 compat pilot isolation guard removed": (C, "      if (pilot) {", "      if (false) {"),
    "W8 certification worker accepts production token": (W, 'for(const key of ["MERCADOPAGO_ACCESS_TOKEN","MERCADOPAGO_WEBHOOK_SECRET",', 'for(const key of ["MERCADOPAGO_WEBHOOK_SECRET",'),
    "W9 certification worker accepts production webhook secret": (W, 'for(const key of ["MERCADOPAGO_ACCESS_TOKEN","MERCADOPAGO_WEBHOOK_SECRET",', 'for(const key of ["MERCADOPAGO_ACCESS_TOKEN",'),
    "W10 certification worker routes production provider": (W, 'url.search!=="?provider=mercadopago_test"', '!url.search.startsWith("?provider=mercadopago")'),
    # gate estático
    "G1 R1 disabled": (G, "if is_sandbox_name(n) and environment != SANDBOX_ENVIRONMENT and n not in legacy:", "if False and is_sandbox_name(n):"),
    "G2 legacy exception widened to CERTIFICATION_*": (G, "and n not in legacy:", 'and not n.startswith("CERTIFICATION_"):'),
    "G3 R2 disabled": (G, "if n in refs and is_production_name(n) and environment == SANDBOX_ENVIRONMENT:", "if False and n in refs:"),
    "G4 secrets['X'] syntax ignored": (G, "            refs.update(SECRET_INDEX.findall(s))\n", ""),
    "G5 env-bound names ignored": (G, '        bound = set(wf_bound) | env_bound_names(job.get("env"))', "        bound = set(wf_bound)"),
    "G6 workflow-level env ignored": (G, "    wf_refs, wf_bound = secret_refs(wf_env), env_bound_names(wf_env)", "    wf_refs, wf_bound = set(), set()"),
    "G7 default wrangler config treated as non-production": (G, '        return True, "(configuração padrão do wrangler)"', '        return False, "(configuração padrão do wrangler)"'),
    "G8 certification target not recognised": (G, '    return (not all("certification" in x.lower() for x in target)), " ".join(target)', '    return True, " ".join(target)'),
    "G9 unresolved dynamic name accepted": (G, "    if not loop:\n        return None", "    if not loop:\n        return [name]"),
    "G10 versions secret put not matched": (G, r"(?:versions\s+)?secret\s+(put|bulk)", r"secret\s+(put|bulk)"),
    "G11 secret bulk ignored": (G, "        else:  # bulk:", "        elif False:  # bulk:"),
    "G12 line continuation not joined": (G, '    joined = re.sub(r"\\\\\\n", " ", script)', "    joined = script"),
    "G13 expression environment accepted": (G, '        if environment and "${{" in environment and sensitive:', "        if False:"),
    "G14 unreadable workflow not fatal": (G, "    code = 2 if errors else (1 if violations else 0)", "    code = 1 if violations else 0"),
    "G15 production config debt widened": (G, "if PUT_FORBIDDEN_NAME.search(n) and n not in config_debt:", 'if PUT_FORBIDDEN_NAME.search(n) and not n.startswith("CERTIFICATION_PILOT_"):'),
    "G16 runtime config assignments ignored": (G, '    re.compile(r"\\bruntime\\s*\\[\\s*[\'\\"]([A-Za-z_][A-Za-z0-9_]*)[\'\\"]\\s*\\]\\s*="),\n', ""),
    "G17 deploy --var not checked": (G, '            if n and PUT_FORBIDDEN_NAME.search(n):\n                found.append((n, target, "wrangler deploy --var', '            if False:\n                found.append((n, target, "wrangler deploy --var'),
    "G18 retired job without if: false accepted": (G, """                out.append({**base, "job": str(jname), "detail": "job perdeu 'if: ${{ false }}'"})""", "                pass"),
    "G19 retired marker not required": (G, "        if len(RETIRED_MARKER.findall(text)) < len(jobs):", "        if False:"),
    "G20 unregistered retired marker accepted": (G, "if p.name not in registered and RETIRED_MARKER.search(", "if False and RETIRED_MARKER.search("),
    "G21 registered retired file may vanish": (G, """            out.append({**base, "job": "-", "detail": "aposentado registrado não existe (remova da lista no mesmo PR)"})""", "            pass"),
    "G22 cleanup may run on merge": (G, """    if events != {"workflow_dispatch"}:""", "    if False:"),
    "G23 cleanup confirmation optional": (G, """    if not (isinstance(ci, dict) and ci.get("required") is True):""", "    if False:"),
    "G24 cleanup any Worker": (G, """        if "--name" not in toks or toks[toks.index("--name") + 1:toks.index("--name") + 2] != ["zevanory"] or any(t.startswith(("--config", "-c")) for t in toks):""", "        if False:"),
    "G25 cleanup allowlist not pinned": (G, """    if not case or tuple(sorted(case.group(1).split("|"))) != tuple(sorted(CLEANUP_ALLOWLIST)):""", "    if False:"),
    "G26 resolved debt may stay listed": (G, """        if e.get("status") not in (None, "OPEN") and isinstance(e.get("status"), str):""", "        if False:"),
    "G27 missing debt registry accepted": (G, """        return None, [f"{DEBT_FILE.as_posix()} ausente"]""", """        return {"pending": [], "retired_workflows": []}, []"""),
    "G28 R1 exception hardcoded (not from registry)": (G, """    legacy = frozenset(e["name"] for e in pending if e.get("github_secret_exception") is True and isinstance(e.get("name"), str))""", """    legacy = frozenset({"CERTIFICATION_E2E_TOKEN"})"""),
    # readback / remoção dirigida
    "S1 confirmation not exact": (S, 'typeof confirmation !== "string" || confirmation !== CONFIRMATION_PHRASE', 'typeof confirmation !== "string" || !confirmation.includes("MERCADOPAGO_TEST_ACCESS_TOKEN")'),
    "S2 delete set ignores presence": (S, "  const toDelete = REMOVAL_ALLOWLIST.filter((n) => present.has(n));", "  const toDelete = [...REMOVAL_ALLOWLIST];"),
    "S3 kept list drops CERTIFICATION names": (S, "  const kept = [...present].filter((n) => !toDelete.includes(n)).sort();", "  const kept = [...present].filter((n) => !toDelete.includes(n) && !FORBIDDEN_IN_PRODUCTION.test(n)).sort();"),
    "S4 verify ignores lost names": (S, "  return { ok: stillPresent.length === 0 && lostKept.length === 0,", "  return { ok: stillPresent.length === 0,"),
    "S5 verify ignores names still present": (S, "  return { ok: stillPresent.length === 0 && lostKept.length === 0,", "  return { ok: lostKept.length === 0,"),
    "S6 target proof bypassed": (S, "  return { ok: value === TARGET.environment,", "  return { ok: true,"),
    "S7 readback debt widened to any CERTIFICATION": (S, "    if (!strict && Object.hasOwn(registry.names, entry.name)) debt.push(entry);", '    if (!strict && entry.name.includes("CERTIFICATION")) debt.push(entry);'),
    "S8 strict mode ignored": (S, "    if (!strict && Object.hasOwn(registry.names, entry.name)) debt.push(entry);", "    if (Object.hasOwn(registry.names, entry.name)) debt.push(entry);"),
    "S9 runtime config keys ignored": (S, "        for (const key of Object.keys(raw)) if (NAME.test(key)) out.push(", "        for (const key of []) if (NAME.test(key)) out.push("),
    "S10 non-secret allowlisted name accepted": (S, '  if (notSecret.length) return { ok: false, error: "allowlisted_name_is_not_a_secret", toDelete: [], notSecret };\n', ""),
    "S11 plan file leaks settings": (S, "      writeFileSync(out, JSON.stringify({ toDelete: p.toDelete, kept: p.kept }));", "      writeFileSync(out, JSON.stringify({ toDelete: p.toDelete, kept: p.kept, settings }));"),
    "S13 strict ignores open debt": (S, "  const openDebt = strict ? registry.pending.map((e) => e.id) : [];", "  const openDebt = [];"),
    "S14 debt registry without reason/PR accepted": (S, """ || !String(e.reason || "").trim() || !String(e.planned_pr || "").trim()) throw new InputError("debt_registry_invalid");""", """) throw new InputError("debt_registry_invalid");"""),
    "S12 malformed secret list accepted": (S, '  if (!Array.isArray(data)) throw new InputError("secret_list_not_array");', "  if (!Array.isArray(data)) return [];"),
}

ALLOW_FILE = Path(os.environ.get("CREDENTIAL_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_credential_separation_allow.json"))


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
