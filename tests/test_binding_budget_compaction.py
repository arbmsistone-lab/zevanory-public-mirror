"""Regression: compact only redundant or default-equal public values, never commercial gates.

The compaction loop moves plain Worker variables into ZEVANORY_RUNTIME_CONFIG (one binding),
read back under their old names by the normalizeEnv proxy patched in the same script. It frees
Workers Free binding slots (check-binding-budget.py: max 60) for owner-authorized secrets.
"""
import ast
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy/prepare-central-candidate.py"
RECOVERED = ROOT / "worker/cloudflare-worker.recovered.mjs"

# The value this test has always required to stay accessible after compaction. ZEVANORY_WHATSAPP_DISPLAY
# left the list when WhatsApp was retired (PR #896): the generator no longer emits it at all.
REQUIRED = ["ZEVANORY_RELEASE_REF"]
# Every other compacted key needs an explicit, reviewed justification here.
REVIEWED_EXTRA = {
    "AGENT_AUTONOMY_MODE": "12/10, slot for GEMINI_API_KEY; code default 'guarded' (safest)",
    "AGENT_AI_MAX_RUNS_PER_HOUR": "13/10 T3, slot for LEAD_PRIVACY_SECRET; configured '100' == code default 100",
}
# Commercial, financial, release and safety gates must never leave their own binding.
NEVER_COMPACT = {
    "SALE_GLOBALLY_ENABLED", "MERCADOPAGO_ENV", "PRE_SALE_GATES_APPROVED", "ABSOLUTE_RELEASE_APPROVED",
    "CHECKOUT_ENABLED", "FINANCIAL_EVENTS_ENABLED", "PAYMENT_PROVIDER", "PAYMENT_RUNTIME_MODE",
    "PAYMENT_MERCHANT_IDENTITY_VERIFIED", "PAYMENT_PUBLIC_BASE_URL", "WHATSAPP_SALES_ENABLED",
    "ASAAS_ENV",
    "AGENT_HUMAN_APPROVAL_REQUIRED", "AGENT_AI_ENABLED", "ZEVANORY_RELEASE_SHA", "ZEVANORY_DEPLOYMENT_ENV",
}


def compaction_loops(source):
    return [node for node in source.body if isinstance(node, ast.For)
            and isinstance(node.target, ast.Name) and node.target.id == "key"
            and isinstance(node.iter, ast.Tuple)
            and [n.value for n in node.iter.elts if isinstance(n, ast.Constant)][:1] == REQUIRED]


class BindingBudgetAliasTest(unittest.TestCase):
    def setUp(self):
        self.source = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        self.loops = compaction_loops(self.source)

    def keys(self):
        return [n.value for n in self.loops[0].iter.elts]

    def test_compacted_release_and_contact_values_remain_accessible(self):
        self.assertEqual(len(self.loops), 1, "expected the explicit safe compaction loop")
        keys = self.keys()
        self.assertEqual(keys[:1], REQUIRED)
        self.assertEqual(set(keys[1:]), set(REVIEWED_EXTRA), "every extra compacted key must be reviewed here")
        before = {"ZEVANORY_RELEASE_REF": "gh-pages",
                  "AGENT_AUTONOMY_MODE": "progressive",
                  "AGENT_AI_MAX_RUNS_PER_HOUR": "100",
                  "SALE_GLOBALLY_ENABLED": "false",
                  "MERCADOPAGO_ENV": "production",
                  "PRE_SALE_GATES_APPROVED": "false"}
        c = {"vars": dict(before)}
        runtime_config = {}
        compiled = compile(ast.fix_missing_locations(ast.Module(body=self.loops, type_ignores=[])), str(SCRIPT), "exec")
        exec(compiled, {"c": c, "runtime_config": runtime_config})
        self.assertEqual(runtime_config, {k: before[k] for k in keys})
        self.assertEqual(set(before) - set(c["vars"]), set(runtime_config))
        for gate in ("SALE_GLOBALLY_ENABLED", "MERCADOPAGO_ENV", "PRE_SALE_GATES_APPROVED"):
            self.assertEqual(c["vars"][gate], before[gate])

    def test_never_compacts_a_gate(self):
        self.assertFalse(set(self.keys()) & NEVER_COMPACT)

    def test_runtime_config_fallback_is_wired_in_normalize_env(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('const runtime = Reflect.get(target, "ZEVANORY_RUNTIME_CONFIG", receiver);', text)
        self.assertIn('if (runtime && typeof runtime === "object" && prop in runtime) return runtime[prop];', text)

    def test_agent_ai_cap_is_behaviour_neutral(self):
        # Single reader (runAgentOnce, env = options.env || process.env). process.env holds the raw
        # bindings, so after compaction the name is absent there and the code default applies. The
        # change is neutral only because that default (100) equals the configured value ("100").
        code = RECOVERED.read_text(encoding="utf-8")
        readers = re.findall(r".*AGENT_AI_MAX_RUNS_PER_HOUR.*", code)
        self.assertEqual(len(readers), 1, readers)
        self.assertIn("Number(env.AGENT_AI_MAX_RUNS_PER_HOUR) || 100", readers[0])
        self.assertIn("const env = options.env || process.env;", code)

    def test_configured_cap_equals_code_default(self):
        # The central deploy builds its config from wrangler.jsonc at 83620c6 (central-production-deploy.yml).
        import subprocess
        out = subprocess.run(["git", "-C", str(ROOT), "show", "83620c680958d726fc4b0fd16e2574cdcc362a6d:wrangler.jsonc"],
                             capture_output=True, text=True)
        if out.returncode != 0:
            self.skipTest("deploy base 83620c6 not in this checkout")
        self.assertEqual(json.loads(out.stdout)["vars"]["AGENT_AI_MAX_RUNS_PER_HOUR"], "100")
        for d in (ROOT / "worker").rglob("*.mjs"):
            if d.name != RECOVERED.name:
                self.assertNotIn("AGENT_AI_MAX_RUNS_PER_HOUR", d.read_text(encoding="utf-8"), d.name)


# ---------------------------------------------------------------------------------------------------------------
# P20 (docs/p20/vaga-binding-p20-backup-key.md): OFFER_SELECTION_APPROVED and SERVICE_DELIVERY_MODE move from the
# top-level vars into ZEVANORY_RUNTIME_CONFIG to free slots for the ONE new secret P20_BACKUP_KEY.
# Proof against the REAL generator, the pinned deploy base, the REAL normalizers (patched binding-aliases +
# production-pilot-guard) and the REAL hydrateRuntimeConfig source of the recovered bundle.
import os
import shutil
import subprocess
import sys
import tempfile

BASE = "83620c680958d726fc4b0fd16e2574cdcc362a6d"
P20_KEYS = ("OFFER_SELECTION_APPROVED", "SERVICE_DELIVERY_MODE")
P20_MARK = "# P20 (docs/p20/vaga-binding-p20-backup-key.md)"
BUDGET = ROOT / "scripts/deploy/check-binding-budget.py"


def _git(*args, **kw):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, **kw)


def _base_available():
    return _git("cat-file", "-e", BASE + "^{commit}").returncode == 0


def build_candidate(tmp, script_text, base_mutator=None, extra_env=None):
    """Runs the generator exactly as central-production-deploy.yml does (base wrangler.jsonc + public/ of 83620c6)."""
    tmp = pathlib.Path(tmp)
    for rel in ("scripts/deploy/public_whatsapp_scan.py", "worker/binding-aliases.mjs", "worker/cloudflare-worker.recovered.mjs",
                "worker/production-pilot-guard.mjs", "worker/operator-credential.mjs"):
        (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, tmp / rel)
    (tmp / "scripts/deploy/prepare-central-candidate.py").write_text(script_text, encoding="utf-8")
    arch = _git("archive", BASE, "public")
    subprocess.run(["tar", "-x", "-C", str(tmp)], input=arch.stdout, check=True)
    base = json.loads(_git("show", BASE + ":wrangler.jsonc", text=True).stdout)
    if base_mutator:
        base_mutator(base)
    (tmp / "wrangler.central-fix.jsonc").write_text(json.dumps(base), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k not in ("ZEVANORY_LAUNCH_AUTHORIZATION", "OPERATOR_TOKEN_MIGRATION_UNTIL", "DIARIO_D1_MODO")}
    env.update(PUBLIC_OWNER_ACCOUNT_ID="0" * 32, TARGET_RUNTIME_SHA="a" * 40, PYTHONDONTWRITEBYTECODE="1", **(extra_env or {}))
    r = subprocess.run([sys.executable, "scripts/deploy/prepare-central-candidate.py"], cwd=tmp, env=env, capture_output=True, text=True)
    if r.returncode:
        return None, r.stdout + r.stderr
    return json.loads((tmp / "wrangler.central-fix.jsonc").read_text(encoding="utf-8")), r.stdout


def script_without_p20_block():
    text = SCRIPT.read_text(encoding="utf-8")
    start, end = text.index(P20_MARK), text.index('open(p,"w").write(json.dumps(c,indent=2)+"\\n")')
    return text[:start] + text[end:]


def budget(config, secrets):
    with tempfile.TemporaryDirectory() as d:
        cp, sp = pathlib.Path(d, "c.json"), pathlib.Path(d, "s.json")
        cp.write_text(json.dumps(config), encoding="utf-8")
        sp.write_text(json.dumps({"result": {"bindings": [{"name": n, "type": "secret_text"} for n in secrets]}}), encoding="utf-8")
        r = subprocess.run([sys.executable, str(BUDGET), str(cp), str(sp)], capture_output=True, text=True)
    m = re.search(r"planned=(\d+)", r.stdout + r.stderr)
    return r.returncode, int(m.group(1)) if m else None


NODE_EQUIV = r"""
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [dir, beforePath, afterPath] = process.argv.slice(2);
const { normalizeEnv } = await import(pathToFileURL(dir + "/worker/binding-aliases.mjs"));      // patched by the generator
const { productionEnvView } = await import(pathToFileURL(dir + "/worker/production-pilot-guard.mjs"));
const rec = readFileSync(dir + "/worker/cloudflare-worker.recovered.mjs", "utf8");
const a = rec.indexOf("var FAIL_CLOSED_RUNTIME_FLAGS"), b = rec.indexOf("__name(hydrateRuntimeConfig");
const hydrateRuntimeConfig = new Function(rec.slice(a, b) + "; return hydrateRuntimeConfig;")();  // real source
const view = (vars) => {
  const n = normalizeEnv(productionEnvView({ ...vars }));
  const target = hydrateRuntimeConfig(n, {});
  return { n, target };
};
const before = JSON.parse(readFileSync(beforePath, "utf8")).vars, after = JSON.parse(readFileSync(afterPath, "utf8")).vars;
const keys = [...new Set([...Object.keys(before), ...Object.keys(before.ZEVANORY_RUNTIME_CONFIG || {}), ...Object.keys(after), ...Object.keys(after.ZEVANORY_RUNTIME_CONFIG || {})])]
  .filter((k) => k !== "ZEVANORY_RUNTIME_CONFIG").sort();
const B = view(before), A = view(after);
const diff = [];
for (const k of keys) {
  if (B.n[k] !== A.n[k] || (k in B.n) !== (k in A.n)) diff.push("normalized:" + k);
  if (B.target[k] !== A.target[k]) diff.push("hydrated:" + k);
}
const pick = (o) => Object.fromEntries(["OFFER_SELECTION_APPROVED", "SERVICE_DELIVERY_MODE"].map((k) => [k, o[k] ?? null]));
console.log(JSON.stringify({ keys: keys.length, diff, before: { n: pick(B.n), h: pick(B.target) }, after: { n: pick(A.n), h: pick(A.target) } }));
"""


@unittest.skipUnless(_base_available(), "deploy base 83620c6 not in this checkout (CI fetches it before this step)")
class P20BindingVacancyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.before_dir, cls.after_dir = pathlib.Path(cls.tmp, "before"), pathlib.Path(cls.tmp, "after")
        cls.before, out_b = build_candidate(cls.before_dir, script_without_p20_block())
        cls.after, out_a = build_candidate(cls.after_dir, SCRIPT.read_text(encoding="utf-8"))
        assert cls.before and cls.after, (out_b[-600:], out_a[-600:])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_flags_leave_top_level_with_identical_value_and_nothing_else_changes(self):
        bv, av = self.before["vars"], self.after["vars"]
        self.assertEqual(set(bv) - set(av), set(P20_KEYS))
        self.assertEqual(set(av) - set(bv), set())
        for k in P20_KEYS:
            self.assertIsInstance(bv[k], str)
            self.assertEqual(av["ZEVANORY_RUNTIME_CONFIG"][k], bv[k], k)
            self.assertNotIn(k, bv["ZEVANORY_RUNTIME_CONFIG"], "the base never had them in the runtime config")
        self.assertEqual((bv["OFFER_SELECTION_APPROVED"], bv["SERVICE_DELIVERY_MODE"]), ("true", "digital"))
        rest_b = {k: v for k, v in bv.items() if k not in P20_KEYS + ("ZEVANORY_RUNTIME_CONFIG",)}
        rest_a = {k: v for k, v in av.items() if k != "ZEVANORY_RUNTIME_CONFIG"}
        self.assertEqual(rest_a, rest_b, "every other var (sales, checkout, financial, compliance...) unchanged")
        rc_a = {k: v for k, v in av["ZEVANORY_RUNTIME_CONFIG"].items() if k not in P20_KEYS}
        self.assertEqual(rc_a, bv["ZEVANORY_RUNTIME_CONFIG"])
        self.assertEqual({k: v for k, v in self.after.items() if k != "vars"}, {k: v for k, v in self.before.items() if k != "vars"})

    def test_budget_60_to_58_and_59_with_the_new_secret(self):
        n_vars = len(self.before["vars"])
        secrets = [f"SYNTHETIC_SECRET_{i:02d}" for i in range(60 - n_vars - 1)]  # +1 = CHANNEL_CREDENTIALS_JSON
        self.assertEqual(budget(self.before, secrets), (0, 60), "premise: the budget is full today")
        self.assertEqual(budget(self.before, secrets + ["P20_BACKUP_KEY"]), (1, 61), "without compaction the new secret blocks the deploy")
        self.assertEqual(budget(self.after, secrets), (0, 58))
        self.assertEqual(budget(self.after, secrets + ["P20_BACKUP_KEY"]), (0, 59), "one slot to spare after the owner adds the key")

    def test_real_normalizers_resolve_every_name_identically(self):
        with tempfile.TemporaryDirectory() as d:
            bp, ap, js = pathlib.Path(d, "b.json"), pathlib.Path(d, "a.json"), pathlib.Path(d, "eq.mjs")
            bp.write_text(json.dumps(self.before), encoding="utf-8")
            ap.write_text(json.dumps(self.after), encoding="utf-8")
            js.write_text(NODE_EQUIV, encoding="utf-8")
            r = subprocess.run(["node", str(js), str(self.after_dir), str(bp), str(ap)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(out["diff"], [], "normalizeEnv and hydrateRuntimeConfig must return the same value for every name")
        self.assertGreater(out["keys"], 70)
        want = {"OFFER_SELECTION_APPROVED": "true", "SERVICE_DELIVERY_MODE": "digital"}
        for side in ("before", "after"):
            self.assertEqual(out[side]["n"], want, side)
            self.assertEqual(out[side]["h"], want, side)

    def test_conflicting_runtime_config_value_fails_closed(self):
        def conflict(base):
            base["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG", {})["SERVICE_DELIVERY_MODE"] = "remote"
        with tempfile.TemporaryDirectory() as d:
            cfg, out = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), conflict)
        self.assertIsNone(cfg)
        self.assertIn("RUNTIME_CONFIG_COMPACTION_CONFLICT SERVICE_DELIVERY_MODE", out)
        def same(base):
            base["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG", {})["SERVICE_DELIVERY_MODE"] = base["vars"]["SERVICE_DELIVERY_MODE"]
        with tempfile.TemporaryDirectory() as d:
            cfg, _ = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), same)
        self.assertEqual(cfg["vars"]["ZEVANORY_RUNTIME_CONFIG"]["SERVICE_DELIVERY_MODE"], "digital")


class P20BindingVacancyStaticTest(unittest.TestCase):
    """Readers and writers of the two names. A new reader or writer anywhere breaks this test until reviewed."""

    def hits(self, name):
        out = []
        roots = [ROOT / "worker", ROOT / "scripts", ROOT / ".github/workflows", ROOT / "sales-worker.mjs"]
        files = [p for r in roots for p in ([r] if r.is_file() else r.rglob("*")) if p.is_file() and p.suffix in (".mjs", ".js", ".py", ".yml", ".yaml", ".sh", ".json", ".jsonc", ".toml")]
        for p in files:
            for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
                if name in line:
                    out.append((p.relative_to(ROOT).as_posix(), i, line.strip()))
        return out

    def test_single_reader_through_resolved_env(self):
        code = RECOVERED.read_text(encoding="utf-8")
        start = code.index("function evaluateActivationReadiness(env = process.env) {")
        end = code.index('__name(evaluateActivationReadiness, "evaluateActivationReadiness")')
        for name in P20_KEYS:
            h = [x for x in self.hits(name) if x[0] != "scripts/deploy/prepare-central-candidate.py"]
            files = {x[0] for x in h}
            self.assertEqual(files, {"worker/cloudflare-worker.recovered.mjs"}, (name, h))
            reads = [x for x in h if f"env.{name}" in x[2]]
            self.assertEqual(len(reads), 1, (name, reads))
            self.assertEqual(code.count(f"env.{name}"), 1)
            self.assertTrue(start < code.index(f"env.{name}") < end, name + " read only inside evaluateActivationReadiness")
            others = [x for x in h if f"env.{name}" not in x[2]]
            self.assertTrue(all('requirement("commercial", ["' + name + '"], "decision")' in x[2] for x in others), others)
        body = code[start:end]
        self.assertIn("env.ARBM_SIST_PRIVATE_PILOT_DELIVERY_APPROVED", body, "same env already serves compacted flags")
        flags = re.search(r"FAIL_CLOSED_RUNTIME_FLAGS = Object\.freeze\(\[([^\]]*)\]\)", code).group(1)
        for name in P20_KEYS:
            self.assertNotIn(name, flags, "hydrateRuntimeConfig would force it to 'false' and ignore the runtime config")
            self.assertNotIn(name, NEVER_COMPACT)
            self.assertNotRegex(name, r"TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL")

    def test_no_env_spread_reaches_the_reader(self):
        # Spreading the normalizeEnv proxy would drop runtime-config names. Every `...env` in the bundle is local to a
        # function that never reaches evaluateActivationReadiness (WhatsApp channel readiness, voice, Mercado Pago drain).
        code = RECOVERED.read_text(encoding="utf-8").split("\n")
        spreads = [i + 1 for i, l in enumerate(code) if re.search(r"\.\.\.env\b", l)]
        allowed = {"channelReadiness", "ttsBytesFromRuntime", "runPaidDeliveryWatchdog", "fetch"}
        def enclosing(i):
            for j in range(i - 1, -1, -1):
                m = re.match(r"^\s*(?:async\s+)?(?:function\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{", code[j])
                if m and not code[j].lstrip().startswith(("if", "for", "while", "switch", "catch", "return")):
                    return m.group(1)
            return None
        found = {enclosing(i) for i in spreads}
        self.assertTrue(found <= allowed, found)
        src_all = "\n".join(code)
        # Inside fetch the only spread is the voice status env (statusEnv), consumed by voiceProviderStatus alone.
        in_fetch = [code[i - 1] for i in spreads if enclosing(i) == "fetch"]
        self.assertTrue(all("statusEnv = Object.freeze({ ...env, GEMINI_API_KEY" in l for l in in_fetch), in_fetch)
        self.assertEqual(sorted(set(re.findall(r"\w+\(statusEnv\)", src_all))), ["voiceProviderStatus(statusEnv)"])
        self.assertEqual(sorted(set(re.findall(r"(\w+)\([^()]*runtimeEnv", src_all))), ["String", "synthesizeWhatsappVoice", "ttsBytesWithFailover"])
        for fn in ("channelReadiness", "ttsBytesFromRuntime"):
            src = "\n".join(code)
            body = src[src.index(f"function {fn}("):]
            body = body[:body.index(f'__name({fn}, "{fn}")')]
            self.assertNotRegex(body, r"salesGate|evaluateActivationReadiness|preSaleApproval|certificationPilotPolicy|buildActivationPlan")

    def test_all_entry_points_hydrate_and_pass_the_normalized_env(self):
        rec = RECOVERED.read_text(encoding="utf-8")
        for fn in ("async scheduled(controller, env, ctx) {\n    hydrateRuntimeConfig(env);", "async function runSalesPreflight(env) {\n  hydrateRuntimeConfig(env);",
                   "async function runPaidDeliveryWatchdog(env) {\n  hydrateRuntimeConfig(env);"):
            self.assertIn(fn, rec)
        self.assertRegex(rec, r"async fetch\(request, env\) \{\n(?:.*\n){0,3}\s+hydrateRuntimeConfig\(env\);")
        compat = (ROOT / "worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
        for call in re.findall(r"(?:worker\.fetch|runSalesPreflight|runPaidDeliveryWatchdog|fetchJsonThroughWorker)\(([^)]*)\)", compat):
            args = [a.strip() for a in call.split(",")]
            if args[0] in ("request, env, ctx",) or args == ["request", "env", "ctx"]:
                continue  # fetchJsonThroughWorker's own body forwards its env parameter
            self.assertIn("normalized", args, call)

    def test_other_writers_of_the_central_config(self):
        wf = ROOT / ".github/workflows"
        # Only the central deploy (and its dry-runs) use the generator; it is the single writer of the live config.
        self.assertIn("python3 scripts/deploy/prepare-central-candidate.py", (wf / "central-production-deploy.yml").read_text(encoding="utf-8"))
        # Retired recovery path built its own config from the base: it must stay unrunnable.
        mp = (wf / "mercadopago-exact-sha-recovery.yml").read_text(encoding="utf-8")
        self.assertIn("if: ${{ false }}", mp)
        # central-fix-candidate builds from the base but only ever dry-runs.
        fix = (wf / "central-fix-candidate.yml").read_text(encoding="utf-8")
        for line in fix.split("\n"):
            if re.search(r"wrangler@[\d.]+ (deploy|versions|rollback)", line) and not line.strip().startswith("#"):
                self.assertIn("--dry-run", line)
        # Automatic rollback restores a previous version as a whole (old top-level vars, same values): no new writer.
        self.assertIn("rollback --name zevanory", (wf / "central-production-deploy.yml").read_text(encoding="utf-8"))




# ---------------------------------------------------------------------------------------------------------------
# P20 diário D1 (docs/p20/diario-d1.md, seções "Binding e migração" e "Primeiro deploy com D1"). NO-GO do GPT-6
# (NC-P2b-DEP-01/02/03): o gerador só injeta o binding DIARIO em DIARIO_D1_MODO=certificar; off (padrão, push e
# dispatch sem input) e rollback saem SEM DIARIO, mesmo com os segredos D1 cadastrados. Prova com o gerador REAL sobre a
# base fixada, o texto REAL dos passos do workflow (curl/npx falsos), o promotion_guard REAL (motivo=d1-config) e o
# script REAL de certificação. Mutantes no fim (DiarioD1MutantsTest). O isolamento das credenciais D1 e os ramos de
# migração/readback com os segredos falsos estão em tests/test_diario_d1_credentials.py.
import importlib.util  # noqa: E402
import types  # noqa: E402

DIARIO_WANTED = {
    "binding": "DIARIO",
    "database_name": "zevanory-diario-p20",
    "database_id": "1b1bfa19-ccc5-423a-bc1f-62d89020c8e2",
    "migrations_dir": "migrations/d1",
}
CERT_D1_ID = "7ff006f3-1daf-44c5-9494-aabab600608e"
CERTIFY = ROOT / "scripts/deploy/diario_d1_certify.py"
GUARD = ROOT / "scripts/deploy/promotion_guard.py"
WORKFLOW = ROOT / ".github/workflows/central-production-deploy.yml"
SHA_A, SHA_B, SHA_C, SHA_X = "a" * 40, "b" * 40, "c" * 40, "e" * 40  # A <- B <- C (ponta); X divergente


def _module_from(path, text=None, name=None):
    mod = types.ModuleType(name or path.stem)
    mod.__file__ = str(path)
    exec(compile(text if text is not None else path.read_text(encoding="utf-8"), str(path), "exec"), mod.__dict__)
    return mod


def _diario_injector(text=None):
    """Extrai do gerador real a constante e as funções de injeção (sem rodar o resto do script)."""
    tree = ast.parse(text if text is not None else SCRIPT.read_text(encoding="utf-8"))
    names = {"DIARIO_D1_BINDING", "DIARIO_D1_FORBIDDEN_PREFIX", "DIARIO_D1_MODOS", "_inject_diario_d1", "_apply_diario_d1"}
    body = [n for n in tree.body if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in n.targets))
            or (isinstance(n, ast.FunctionDef) and n.name in names)]
    ns = {}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(SCRIPT), "exec"), ns)
    return ns


# --- verificações do gerador (recebem o namespace para os mutantes passarem pelo mesmo crivo) -------------------
def check_generator_modes(ns):
    apply = ns["_apply_diario_d1"]
    assert ns["DIARIO_D1_BINDING"] == DIARIO_WANTED
    for modo in ("certificar", "manter"):
        c = apply({}, modo)
        assert c["d1_databases"] == [DIARIO_WANTED], (modo, c)
    for modo in ("off", "rollback", "", None):
        c = apply({"d1_databases": [dict(DIARIO_WANTED)]}, modo)
        assert "d1_databases" not in c, (modo, c)
        c = apply({"d1_databases": [dict(DIARIO_WANTED), {"binding": "OUTRO", "database_id": "aaaa"}]}, modo)
        assert c["d1_databases"] == [{"binding": "OUTRO", "database_id": "aaaa"}], (modo, c)
        try:
            apply({"d1_databases": [{"binding": "X", "database_id": CERT_D1_ID}]}, modo)
        except SystemExit as e:
            assert "DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN" in str(e)
        else:
            raise AssertionError(f"banco de certificação aceito em modo {modo!r}")
    for bad in ("CERTIFICAR", "on", "certificar "):
        try:
            apply({}, bad)
        except SystemExit as e:
            assert "DIARIO_D1_MODO_INVALIDO" in str(e)
        else:
            raise AssertionError(f"modo inválido aceito: {bad!r}")


class DiarioD1BindingUnitTest(unittest.TestCase):
    def setUp(self):
        self.ns = _diario_injector()

    def test_constante_documentada_e_exata(self):
        self.assertEqual(self.ns["DIARIO_D1_BINDING"], DIARIO_WANTED)
        self.assertEqual(self.ns["DIARIO_D1_FORBIDDEN_PREFIX"], "7ff006f3")
        self.assertTrue((ROOT / "migrations/d1/0001_diario_v1.sql").is_file(), "migrations_dir aponta para a migração real")
        doc = (ROOT / "docs/p20/diario-d1.md").read_text(encoding="utf-8")
        self.assertIn("## Binding e migração", doc)
        self.assertIn("## Primeiro deploy com D1: modos off, certificar e rollback", doc)
        self.assertIn(DIARIO_WANTED["database_id"], doc)

    def test_injeta_uma_vez_e_e_idempotente(self):
        c = {"d1_databases": [{"binding": "OUTRO", "database_id": "aaaa"}]}
        self.ns["_inject_diario_d1"](c)
        self.ns["_inject_diario_d1"](c)
        self.assertEqual([r for r in c["d1_databases"] if r["binding"] == "DIARIO"], [DIARIO_WANTED])
        self.assertEqual(len(c["d1_databases"]), 2)

    def test_recusa_banco_de_certificacao(self):
        inj = self.ns["_inject_diario_d1"]
        with self.assertRaisesRegex(SystemExit, "DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN"):
            inj({}, dict(DIARIO_WANTED, database_id=CERT_D1_ID))
        with self.assertRaisesRegex(SystemExit, "DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN"):
            inj({}, dict(DIARIO_WANTED, database_id=CERT_D1_ID.upper()))
        with self.assertRaisesRegex(SystemExit, "DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN"):
            inj({"d1_databases": [{"binding": "X", "database_id": CERT_D1_ID}]})

    def test_recusa_diario_divergente(self):
        inj = self.ns["_inject_diario_d1"]
        for other in (dict(DIARIO_WANTED, database_id="22222222-2222-4222-8222-222222222222"),
                      dict(DIARIO_WANTED, database_name="outro"), {"binding": "DIARIO", "database_id": DIARIO_WANTED["database_id"]}):
            with self.assertRaisesRegex(SystemExit, "DIARIO_D1_BINDING_CONFLICT"):
                inj({"d1_databases": [other]})
        with self.assertRaisesRegex(SystemExit, "DIARIO_D1_BINDING_CONFLICT"):
            inj({"d1_databases": [dict(DIARIO_WANTED), dict(DIARIO_WANTED)]})

    def test_modos_off_certificar_rollback(self):
        check_generator_modes(self.ns)


@unittest.skipUnless(_base_available(), "deploy base 83620c6 not in this checkout (CI fetches it before this step)")
class DiarioD1BindingGeneratorTest(unittest.TestCase):
    """O gerador REAL sobre a base fixada, nos três modos e sem modo (push, dry-runs e os outros workflows)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfgs, cls.outs = {}, {}
        for modo in ("", "off", "certificar", "manter", "rollback"):
            cfg, out = build_candidate(pathlib.Path(cls.tmp, modo or "padrao"), SCRIPT.read_text(encoding="utf-8"),
                                       extra_env={"DIARIO_D1_MODO": modo} if modo else None)
            assert cfg, (modo, out[-600:])
            cls.cfgs[modo], cls.outs[modo] = cfg, out

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_sem_modo_off_e_rollback_saem_sem_diario(self):
        for modo in ("", "off", "rollback"):
            self.assertNotIn("d1_databases", self.cfgs[modo], modo)
            self.assertIn(f"DIARIO_D1_CANDIDATO=sem_binding modo={modo or 'off'}", self.outs[modo])

    def test_certificar_com_binding_e_id_exato(self):
        cfg = self.cfgs["certificar"]
        self.assertEqual(cfg["d1_databases"], [DIARIO_WANTED], "a base 83620c6 não tem D1; o único é o DIARIO")
        self.assertIn("DIARIO_D1_CANDIDATO=com_binding modo=certificar", self.outs["certificar"])
        self.assertNotIn("DIARIO", cfg["vars"])
        self.assertNotIn(DIARIO_WANTED["database_id"], json.dumps(cfg["vars"]), "o UUID não vai em var")
        # O resto do candidato é idêntico entre os modos: o modo só decide o binding.
        sem = {k: v for k, v in cfg.items() if k != "d1_databases"}
        self.assertEqual(sem, self.cfgs["off"])

    def test_manter_igual_a_certificar(self):
        # manter religa o mesmo binding; quem decide se o banco está certificado é o passo D1 (fail-closed).
        self.assertEqual(self.cfgs["manter"], self.cfgs["certificar"])
        self.assertIn("DIARIO_D1_CANDIDATO=com_binding modo=manter", self.outs["manter"])

    def test_modo_invalido_recusa(self):
        with tempfile.TemporaryDirectory() as d:
            cfg, out = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), extra_env={"DIARIO_D1_MODO": "ligado"})
        self.assertIsNone(cfg)
        self.assertIn("DIARIO_D1_MODO_INVALIDO", out)

    def test_orcamento_de_bindings_inalterado(self):
        # Mesmo cenário do teste da vaga P20: hoje 59/60 com P20_BACKUP_KEY. O D1 não conta.
        cfg = self.cfgs["certificar"]
        n_vars = len(cfg["vars"])
        secrets = [f"SYNTHETIC_SECRET_{i:02d}" for i in range(60 - n_vars - 1 - 2)] + ["P20_BACKUP_KEY"]
        self.assertEqual(budget(cfg, secrets), (0, 59))
        self.assertEqual(budget(self.cfgs["off"], secrets), budget(cfg, secrets))

    def test_recusa_certificacao_na_base_em_qualquer_modo(self):
        def cert(base):
            base["d1_databases"] = [{"binding": "MAIN_DB", "database_id": CERT_D1_ID}]
        for modo in ("", "certificar"):
            with tempfile.TemporaryDirectory() as d:
                cfg, out = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), cert, {"DIARIO_D1_MODO": modo})
            self.assertIsNone(cfg, modo)
            self.assertIn("DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN", out)

    def test_recusa_diario_divergente_na_base_em_certificar(self):
        def other(base):
            base["d1_databases"] = [dict(DIARIO_WANTED, database_id="22222222-2222-4222-8222-222222222222")]
        with tempfile.TemporaryDirectory() as d:
            cfg, out = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), other, {"DIARIO_D1_MODO": "certificar"})
        self.assertIsNone(cfg)
        self.assertIn("DIARIO_D1_BINDING_CONFLICT", out)


# --- workflow: texto real dos passos ----------------------------------------------------------------------------
FAKE_CURL_ROUTES = r"""#!/usr/bin/env bash
out=""; url=""; tok=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift;;
    -H) case "$2" in "Authorization: Bearer "*) tok="${2#Authorization: Bearer }";; esac; shift;;
    http*) url="$1";;
  esac; shift
done
printf 'curl token=%s url=%s\n' "$tok" "$url" >> "$FAKE_CALL_LOG"
python3 - "$url" "$out" <<'PY'
import json, os, sys
url, out = sys.argv[1], sys.argv[2]
routes = json.loads(os.environ.get("FAKE_ROUTES", "{}"))
code, body = "404", '{"success":false}'
for suffix, (c, b) in routes.items():
    if url.endswith(suffix):
        code, body = c, b
if out:
    open(out, "w").write(body if isinstance(body, str) else json.dumps(body))
sys.stdout.write(code)
PY
"""


def workflow_blocks(text=None):
    """{(job, nome do passo): (índice da linha, run, bloco)} sem depender de PyYAML."""
    lines = (text if text is not None else WORKFLOW.read_text(encoding="utf-8")).split("\n")
    jobs_at = lines.index("jobs:")
    job_starts = [i for i in range(jobs_at + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i])]
    out = {}
    for n, js in enumerate(job_starts):
        je = job_starts[n + 1] if n + 1 < len(job_starts) else len(lines)
        names = [i for i in range(js, je) if lines[i].startswith("      - ")]
        for k, i in enumerate(names):
            e = names[k + 1] if k + 1 < len(names) else je
            block = lines[i:e]
            m = re.match(r"^      - name: (.*)$", block[0])
            if not m:
                continue
            r = next((x for x, l in enumerate(block) if l.strip() == "run: |"), None)
            run = "\n".join(l[10:] if l.startswith(" " * 10) else l.strip() for l in block[r + 1:]) if r is not None else ""
            out[(lines[js].strip()[:-1], m.group(1))] = (i, run, "\n".join(block))
    return out


def workflow_step(name_prefix, job="deploy", text=None):
    hit = [(k, v) for k, v in workflow_blocks(text).items() if k[0] == job and k[1].startswith(name_prefix)]
    assert len(hit) == 1, (name_prefix, [k for k, _ in hit])
    return hit[0][1]


MODO = "P20 diário D1 - modo e motivo"
BIND = "P20 diário D1 - binding efetivo"
MIGP = "P20 diário D1 - migrações"
READP = "P20 diário D1 - readback"


def run_text(script, env_extra, cwd=None):
    d = pathlib.Path(tempfile.mkdtemp())
    try:
        (d / "bin").mkdir()
        (d / "bin" / "curl").write_text(FAKE_CURL_ROUTES, encoding="utf-8")
        (d / "bin" / "curl").chmod(0o755)
        for rel in ("scripts", "migrations"):
            (d / rel).symlink_to(ROOT / rel)
        (d / "out").write_text("", encoding="utf-8")
        base = {k: v for k, v in os.environ.items() if not k.startswith(("CLOUDFLARE_", "CF_TOKEN_", "DIARIO_"))}
        env = dict(base, PATH=f"{d / 'bin'}:{os.environ['PATH']}", GITHUB_OUTPUT=str(d / "out"), FAKE_CALL_LOG=str(d / "calls"),
                   PYTHONDONTWRITEBYTECODE="1", **env_extra)
        p = subprocess.run(["bash", "-c", script], cwd=d, env=env, capture_output=True, text=True, timeout=60)
        so = dict(l.split("=", 1) for l in (d / "out").read_text(encoding="utf-8").split("\n") if "=" in l)
        calls = (d / "calls").read_text(encoding="utf-8").splitlines() if (d / "calls").exists() else []
        return p, so, calls
    finally:
        shutil.rmtree(d, True)


def cf_routes(tag=SHA_C, diario=True, db=DIARIO_WANTED["database_id"], versao_bindings=True, settings_code="200",
              deployments=None):
    b = [{"name": "ZEVANORY_PRIVATE_ARTIFACTS", "type": "kv_namespace", "namespace_id": "728a"}]
    if diario:
        b.append({"name": "DIARIO", "type": "d1", "id": db})
    ver = {"id": "v1", "annotations": {"workers/tag": tag}}
    if versao_bindings:
        ver["resources"] = {"bindings": b}
    dep = deployments if deployments is not None else {"deployments": [{"versions": [{"version_id": "v1", "percentage": 100}]}]}
    return {"/deployments": ["200", json.dumps({"success": True, "result": dep})],
            "/versions/v1": ["200", json.dumps({"success": True, "result": ver})],
            "/settings": [settings_code, json.dumps({"success": True, "result": {"bindings": b}})]}


def run_binding_step(modo, routes, text=None):
    _, script, _ = workflow_step(BIND, text=text)
    return run_text(script, {"DIARIO_D1_MODO": modo, "TARGET_RUNTIME_SHA": SHA_C, "CLOUDFLARE_API_TOKEN": "tok-deploy",
                             "CLOUDFLARE_ACCOUNT_ID": "1b26415802588185a86c1d4d3ebf5bdb", "FAKE_ROUTES": json.dumps(routes)})


def run_modo_step(evento, modo, motivo, text=None, padrao="off", arquivo=True):
    """Roda o passo de modo com um .github/diario-d1-modo.json próprio (padrao=None grava um JSON sem a chave)."""
    _, script, _ = workflow_step(MODO, job="guard", text=text)
    pre = ""
    if arquivo:
        body = json.dumps({"padrao": padrao} if padrao is not None else {})
        pre = f"mkdir -p .github && printf '%s' '{body}' > .github/diario-d1-modo.json\n"
    return run_text(pre + script, {"EVENTO": evento, "DIARIO_D1_INPUT": modo, "MOTIVO_INPUT": motivo})


POSTD1 = "P20 diário D1 - pós-promoção NAO_COMPROVADO em certificar"


def _gh_sim():
    spec = importlib.util.spec_from_file_location("gh_actions_sim", ROOT / "tests/gh_actions_sim.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def postd1_runs(modo, state, text=None):
    """Avalia o `if:` real do passo de exceção (gh_actions_sim) e, se rodar, executa o run real. Devolve o exit ou None."""
    _, script, block = workflow_step(POSTD1, text=text)
    m = re.search(r"^        if: (.*)$", block, re.M)
    assert m, "passo de exceção sem if"
    sim = _gh_sim()
    outs = {"steps.auth.outputs.available": "true", "needs.guard.outputs.diario_d1": modo, "steps.postpromo.outputs.state": state}
    expr = m.group(1).strip()
    if not expr.startswith("${{"):
        expr = "${{ " + expr + " }}"
    if sim.evaluate_value(expr, sim.resolver({}, outs)) != "true":
        return None
    p = subprocess.run(["bash", "-c", script], env=dict(os.environ, POST_REASON="x"), capture_output=True, text=True, timeout=30)
    assert "DIARIO_D1_POS_PROMOCAO_NAO_COMPROVADO" in p.stdout, p.stdout
    return p.returncode


# Verificações do workflow (recebem o texto para os mutantes de DiarioD1MutantsTest).
def check_wf_order_and_wiring(text):
    b = workflow_blocks(text)
    idx = {k[1]: v[0] for k, v in b.items() if k[0] == "deploy"}
    name = lambda p: next(n for n in idx if n.startswith(p))  # noqa: E731
    gen = name("Reconstruct exact production candidate")
    mig, dep, bind, rb = name(MIGP), name("Deploy repaired production worker"), name(BIND), name(READP)
    post, rbk = name("Post-promotion effective version"), name("Automatic rollback after failed post-deploy smoke")
    assert idx[gen] < idx[mig] < idx[dep] < idx[bind] < idx[rb] < idx[post] < idx[rbk], "ordem: gerador, migração, deploy, binding, readback, pós-promoção, rollback"
    assert "\n      DIARIO_D1_MODO: ${{ needs.guard.outputs.diario_d1 }}\n" in text, "o modo validado chega ao job deploy (gerador e passos)"
    assert "diario_d1: ${{ steps.modo.outputs.diario_d1 }}" in text and "motivo: ${{ steps.modo.outputs.motivo }}" in text
    assert "needs.guard.outputs.decision == 'promote'" in text, "o deploy só roda com promote"
    _, grun, gblock = workflow_step("Pre-promotion guard", job="guard", text=text)
    assert '--motivo "${PROMOTION_MOTIVO:-rotina}"' in grun and "PROMOTION_MOTIVO: ${{ steps.modo.outputs.motivo }}" in gblock
    assert idx[gen] >= 0 and "python3 scripts/deploy/prepare-central-candidate.py" in b[("deploy", gen)][1]
    _, rrun, rblock = workflow_step(READP, text=text)
    assert "continue-on-error" not in rblock, "readback da certificação reprova o job"
    _, brun, bblock = workflow_step(BIND, text=text)
    assert "continue-on-error" not in bblock and "secrets." not in bblock, "conferência com o token do deploy do job, sem segredo próprio"
    _, krun, _ = workflow_step("Automatic rollback after failed post-deploy smoke", text=text)
    cert = krun[krun.index(" certificar)\n"):krun.index(" rollback)\n")]
    assert "diario_d1_certify.py binding --expect ausente --duas-fontes ||" in cert, "conferência nas duas fontes depois do rollback de uma certificação"
    rb = krun[krun.index(" rollback)\n"):]
    assert "::error title=DIARIO_D1_ROLLBACK_NAO_CONCLUIDO::" in rb, "risco residual do modo rollback anunciado no log"
    assert krun.index("order12a-financial-proof-renewal.yml") < krun.index("case \"${DIARIO_D1_MODO:-off}\" in"), "a renovação financeira não depende da conferência D1"
    assert "::error title=AUTO_ROLLBACK_HEALTH_FAIL::" in krun
    _, gate, _ = workflow_step("Certification gate", text=text)
    assert 'if [ "${DIARIO_D1_MODO:-off}" = "certificar" ]; then' in gate
    # Guard: o passo de modo lê o arquivo versionado, então vem depois do checkout e antes do guard.
    lines = text.split("\n")
    g0 = lines.index("  guard:")
    g1 = next(i for i in range(g0 + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i]))
    pos = lambda frag: next(i for i in range(g0, g1) if lines[i].startswith("      - ") and frag in lines[i])  # noqa: E731
    assert pos("P21 credencial") < pos("uses: actions/checkout") < pos(MODO) < pos("Pre-promotion guard"), "modo depois do checkout (lê o arquivo versionado)"
    on = text[:text.index("concurrency:")]
    for frag in ('diario_d1:', 'options: ["padrao", "off", "manter", "certificar", "rollback"]', 'default: "padrao"', 'motivo:',
                 'options: ["rotina", "d1-config"]', 'default: "rotina"', '- "migrations/d1/**"', '- "scripts/deploy/diario_d1_certify.py"',
                 '- ".github/diario-d1-modo.json"'):
        assert frag in on, frag
    assert json.loads((ROOT / ".github/diario-d1-modo.json").read_text(encoding="utf-8"))["padrao"] == "off", "padrão versionado de hoje: off"


def check_wf_postpromo(text):
    """NC-1017-01: em certificar, pós-promoção NAO_COMPROVADO falha um passo próprio ANTES do rollback automático (que
    roda em failure()); nos outros modos e com PASS/FAIL nada muda (a regra geral --unproven-exit 0 fica intacta)."""
    _, prun, _ = workflow_step("Post-promotion effective version", text=text)
    assert "--verify-promoted --unproven-exit 0 --service zevanory" in prun, "regra geral T1 intacta"
    idx = {k[1]: v[0] for k, v in workflow_blocks(text).items() if k[0] == "deploy"}
    name = lambda p: next(n for n in idx if n.startswith(p))  # noqa: E731
    assert idx[name("Post-promotion effective version")] < idx[name(POSTD1)] < idx[name("Automatic rollback after failed post-deploy smoke")]
    for modo in ("certificar", "manter", "off", "rollback", ""):
        for state in ("NAO_COMPROVADO", "PASS", "FAIL", ""):
            got = postd1_runs(modo, state, text=text)
            want = 1 if (modo, state) == ("certificar", "NAO_COMPROVADO") else None
            assert got == want, (modo, state, got)


def check_wf_modo_validation(text):
    ok = [(("push", "", "", "off"), ("off", "rotina")), (("push", "", "", "manter"), ("manter", "rotina")),
          (("workflow_dispatch", "", "", "off"), ("off", "rotina")), (("workflow_dispatch", "padrao", "", "manter"), ("manter", "rotina")),
          (("workflow_dispatch", "padrao", "rotina", "off"), ("off", "rotina")),
          (("workflow_dispatch", "off", "rotina", "manter"), ("off", "rotina")),
          (("workflow_dispatch", "manter", "rotina", "off"), ("manter", "rotina")),
          (("workflow_dispatch", "certificar", "d1-config", "off"), ("certificar", "d1-config")),
          (("workflow_dispatch", "certificar", "d1-config", "manter"), ("certificar", "d1-config")),
          (("workflow_dispatch", "rollback", "d1-config", "manter"), ("rollback", "d1-config"))]
    for (ev, modo, motivo, padrao), want in ok:
        p, so, _ = run_modo_step(ev, modo, motivo, text=text, padrao=padrao)
        assert p.returncode == 0 and (so.get("diario_d1"), so.get("motivo")) == want, ((ev, modo, motivo, padrao), p.stdout, so)
    bad = [("workflow_dispatch", "certificar", "rotina", "off"), ("workflow_dispatch", "certificar", "", "off"),
           ("workflow_dispatch", "rollback", "rotina", "off"), ("workflow_dispatch", "off", "d1-config", "off"),
           ("workflow_dispatch", "manter", "d1-config", "off"), ("workflow_dispatch", "padrao", "d1-config", "manter"),
           ("workflow_dispatch", "ligado", "d1-config", "off"), ("workflow_dispatch", "certificar", "codigo", "off"),
           ("push", "certificar", "d1-config", "off"), ("push", "", "d1-config", "off"), ("push", "manter", "", "off"),
           ("push", "", "", "certificar"), ("push", "", "", "rollback"), ("push", "", "", None), ("push", "", "", "ON")]
    for ev, modo, motivo, padrao in bad:
        p, so, _ = run_modo_step(ev, modo, motivo, text=text, padrao=padrao)
        assert p.returncode == 1 and "::error title=" in p.stdout and "diario_d1" not in so, ((ev, modo, motivo, padrao), p.stdout, so)
    p, so, _ = run_modo_step("push", "", "", text=text, arquivo=False)
    assert p.returncode == 1 and "DIARIO_D1_PADRAO_INVALIDO" in p.stdout and "diario_d1" not in so, p.stdout


def check_wf_binding_step(text):
    cases = [
        ("certificar", cf_routes(), 0, "PASS"),
        ("certificar", cf_routes(versao_bindings=False), 1, "NAO_COMPROVADO"),
        ("manter", cf_routes(), 0, "PASS"),
        ("manter", cf_routes(versao_bindings=False), 1, "NAO_COMPROVADO"),
        ("manter", cf_routes(diario=False), 1, "FAIL"),
        ("manter", cf_routes(settings_code="500"), 1, "NAO_COMPROVADO"),
        ("off", cf_routes(diario=False, versao_bindings=False), 0, "PASS"),
        ("certificar", cf_routes(diario=False), 1, "FAIL"),
        ("certificar", cf_routes(db="22222222-2222-4222-8222-222222222222"), 1, "FAIL"),
        ("certificar", cf_routes(tag=SHA_B), 1, "FAIL"),
        ("certificar", cf_routes(settings_code="500"), 1, "NAO_COMPROVADO"),
        ("off", cf_routes(diario=False), 0, "PASS"),
        ("off", cf_routes(diario=True), 1, "FAIL"),
        ("off", cf_routes(settings_code="500"), 0, "NAO_COMPROVADO"),
        ("", cf_routes(diario=False), 0, "PASS"),
        ("rollback", cf_routes(diario=False), 0, "PASS"),
        ("rollback", cf_routes(diario=True), 1, "FAIL"),
        ("rollback", cf_routes(settings_code="500"), 1, "NAO_COMPROVADO"),
        ("rollback", cf_routes(diario=False, deployments={"deployments": [{"versions": [
            {"version_id": "v1", "percentage": 50}, {"version_id": "v0", "percentage": 50}]}]}), 1, "FAIL"),
    ]
    for modo, routes, rc, state in cases:
        p, so, calls = run_binding_step(modo, routes, text=text)
        assert p.returncode == rc and so.get("state") == state, (modo, state, p.stdout, p.stderr, so)
        if state == "NAO_COMPROVADO" and rc == 0:
            assert "::warning title=DIARIO_D1_BINDING_EFETIVO::NAO_COMPROVADO (não é PASS)" in p.stdout, p.stdout
            assert "PASS:" not in p.stdout
        assert calls and all("token=tok-deploy" in c and "/workers/scripts/zevanory/" in c for c in calls), calls


class DiarioD1WorkflowStepTest(unittest.TestCase):
    """Texto REAL dos passos com curl falso (nada sai da máquina). Os passos de migração e readback com os segredos D1
    falsos estão em tests/test_diario_d1_credentials.py."""
    TEXT = WORKFLOW.read_text(encoding="utf-8")

    def test_ordem_e_ligacoes(self):
        check_wf_order_and_wiring(self.TEXT)

    def test_validacao_do_modo_e_do_motivo(self):
        check_wf_modo_validation(self.TEXT)

    def test_binding_efetivo_na_cloudflare(self):
        check_wf_binding_step(self.TEXT)

    def test_pos_promocao_nao_comprovado_em_certificar_dispara_rollback(self):
        check_wf_postpromo(self.TEXT)


# --- NC-P2b-DEP-03: promotion_guard com motivo=d1-config ------------------------------------------------------
def _ancestor(older, newer):
    order = [SHA_A, SHA_B, SHA_C]
    if older == newer:
        return True
    return older in order and newer in order and order.index(older) < order.index(newer)


def check_guard(pg):
    d = lambda cand, http=None, cf=None, motivo="rotina": pg.decide(cand, http, cf, _ancestor, motivo)  # noqa: E731
    # Comportamento de HOJE (rotina), lido no código: o MESMO SHA promove (same_as_live_redeploy); não há caminho em que
    # o mesmo SHA vire skip-superseded. O que barra um redeploy do mesmo SHA são fontes divergentes ou produção ilegível.
    assert d(SHA_C, SHA_C, SHA_C) == ("promote", SHA_C, "same_as_live_redeploy")
    assert d(SHA_C, SHA_C, None) == ("promote", SHA_C, "same_as_live_redeploy")
    assert d(SHA_C, SHA_C, SHA_B)[0] == "refuse" and d(SHA_C)[0] == "refuse"
    assert d(SHA_C, SHA_B, SHA_B) == ("promote", SHA_B, "forward_of_live")
    assert d(SHA_A, SHA_C, SHA_C) == ("skip-superseded", SHA_C, "candidate_older_than_live")
    # d1-config: explícito e estreito.
    assert d(SHA_C, SHA_C, SHA_C, "d1-config") == ("promote", SHA_C, "same_sha_config_only_d1")
    assert d(SHA_C, SHA_C, None, "d1-config") == ("refuse", SHA_C, "config_only_requires_both_sources")
    assert d(SHA_C, None, SHA_C, "d1-config") == ("refuse", SHA_C, "config_only_requires_both_sources")
    assert d(SHA_C, SHA_B, SHA_B, "d1-config") == ("refuse", SHA_B, "config_only_candidate_not_live"), "código novo não viaja com d1-config"
    assert d(SHA_A, SHA_C, SHA_C, "d1-config") == ("refuse", SHA_C, "config_only_candidate_older_than_live"), "SHA antigo continua bloqueado"
    assert d(SHA_X, SHA_C, SHA_C, "d1-config")[0] == "refuse"
    assert d(SHA_C, SHA_C, SHA_B, "d1-config")[0] == "refuse"
    assert d(SHA_C, None, None, "d1-config")[0] == "refuse"
    assert d(SHA_C, SHA_C, SHA_C, "D1-CONFIG") == ("refuse", None, "motivo_invalido")
    assert d(SHA_C, SHA_C, SHA_C, "") == ("refuse", None, "motivo_invalido")


def check_guard_cli(pg):
    """main() real com as duas leituras substituídas: --motivo chega à decisão e às saídas do job."""
    for motivo, live, want, rc in (("d1-config", SHA_C, "promote", 0), ("d1-config", SHA_B, "refuse", 1),
                                   ("rotina", SHA_B, "promote", 0), ("rotina", SHA_C, "promote", 0)):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp, "o")
            out.write_text("", encoding="utf-8")
            old = (pg.readback_sha, pg.cloudflare_sha, pg.is_ancestor, os.environ.get("GITHUB_OUTPUT"))
            pg.readback_sha = lambda *a, **k: live
            pg.cloudflare_sha = lambda *a, **k: live
            pg.is_ancestor = lambda a, b, repo: _ancestor(a, b)
            os.environ["GITHUB_OUTPUT"] = str(out)
            try:
                import contextlib, io
                with contextlib.redirect_stdout(io.StringIO()):
                    got = pg.main(["--service", "zevanory", "--candidate", SHA_C, "--motivo", motivo])
            finally:
                pg.readback_sha, pg.cloudflare_sha, pg.is_ancestor = old[:3]
                if old[3] is None:
                    os.environ.pop("GITHUB_OUTPUT", None)
                else:
                    os.environ["GITHUB_OUTPUT"] = old[3]
            text = out.read_text(encoding="utf-8")
        assert got == rc and f"decision={want}\n" in text, (motivo, live, got, text)


class DiarioD1PromotionGuardTest(unittest.TestCase):
    def test_mesmo_sha_rotina_e_d1_config(self):
        check_guard(_module_from(GUARD))

    def test_cli_motivo(self):
        check_guard_cli(_module_from(GUARD))


# --- script de certificação -------------------------------------------------------------------------------------
def _row(**kw):
    c = _module_from(CERTIFY)
    row = {"diario_head": 1, "migracoes": ",".join(c.MIGRACOES_ESPERADAS),
           "objetos": ",".join(sorted(f"{t}:{n}" for t, n in c.objetos_esperados()))}
    row.update({t: 0 for t in c.tabelas_abandono()})
    row.update(kw)
    return [{"results": [row], "success": True}]


def check_certify(c):
    assert c.MIGRACOES_ESPERADAS == ("0001_diario_v1.sql", "0002_diario_v1_ts.sql", "0003_abandono_v1.sql")
    assert c.migracoes_no_repositorio() == c.MIGRACOES_ESPERADAS
    objs = c.objetos_esperados()
    for o in [("table", "diario_v1"), ("table", "diario_head"), ("table", "d1_migrations"), ("table", "abandono_envio_v1"),
              ("table", "abandono_compra_v1"), ("table", "abandono_supressao_v1"), ("trigger", "diario_v1_sem_update"),
              ("trigger", "diario_v1_sem_delete"), ("trigger", "diario_head_so_avanca"), ("trigger", "diario_head_sem_delete"),
              ("trigger", "abandono_supressao_v1_sem_update"), ("trigger", "abandono_supressao_v1_sem_delete"),
              ("index", "diario_v1_ts")]:
        assert o in objs, o
    assert c.tabelas_abandono() == ["abandono_compra_v1", "abandono_envio_v1", "abandono_supressao_v1"]
    sql = c.sql_certificacao()
    assert sql.lower().startswith("select ") and ";" not in sql
    assert not re.search(r"(?i)\b(insert|update|delete|drop|create|alter|replace|pragma|attach)\b", sql), sql
    # Executa a SQL real num SQLite com as migrações reais: o resumo confere.
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)")
    for m in c.MIGRACOES_ESPERADAS:
        db.executescript((ROOT / "migrations/d1" / m).read_text(encoding="utf-8"))
        db.execute("insert into d1_migrations(name, applied_at) values (?, 'x')", (m,))
    cur = db.execute(sql)
    row = dict(zip([x[0] for x in cur.description], cur.fetchone()))
    r = c.resumo([{"results": [row], "success": True}])
    assert c.verifica(r) == [] and c.verifica(r, antes=r) == [], c.verifica(r)
    db.execute("insert into abandono_compra_v1(ref, criado_ms) values ('x', 1)")
    cur = db.execute(sql)
    r2 = c.resumo([{"results": [dict(zip([x[0] for x in cur.description], cur.fetchone()))], "success": True}])
    assert any("DIARIO_D1_ABANDONO" in e for e in c.verifica(r2)) and any("ANTES_DEPOIS" in e for e in c.verifica(r2, antes=r))
    base = c.resumo(_row())
    assert c.verifica(base) == []
    for kw, marca in ((dict(diario_head=0), "DIARIO_D1_HEAD"), (dict(diario_head=2), "DIARIO_D1_HEAD"),
                      (dict(migracoes="0001_diario_v1.sql,0002_diario_v1_ts.sql"), "DIARIO_D1_MIGRACOES"),
                      (dict(migracoes="0002_diario_v1_ts.sql,0001_diario_v1.sql,0003_abandono_v1.sql"), "DIARIO_D1_MIGRACOES"),
                      (dict(objetos=""), "DIARIO_D1_OBJETOS"), (dict(abandono_envio_v1=3), "DIARIO_D1_ABANDONO"),
                      (dict(objetos=_row()[0]["results"][0]["objetos"] + ",table:intrusa"), "DIARIO_D1_OBJETOS")):
        assert any(e.startswith(marca) for e in c.verifica(c.resumo(_row(**kw)))), (kw, marca)
    try:
        c.resumo([{"results": [], "success": True}])
    except c.Falha:
        pass
    else:
        raise AssertionError("saída sem linha aceita")
    # Migração nova sem revisar a certificação: recusa.
    with tempfile.TemporaryDirectory() as d:
        for m in c.MIGRACOES_ESPERADAS:
            shutil.copyfile(ROOT / "migrations/d1" / m, pathlib.Path(d, m))
        pathlib.Path(d, "0004_nova.sql").write_text("CREATE TABLE IF NOT EXISTS nova (x);", encoding="utf-8")
        try:
            c.objetos_esperados(d)
        except c.Falha as e:
            assert "DIARIO_D1_MIGRACOES_NAO_REVISADAS" in str(e)
        else:
            raise AssertionError("migração não revisada aceita")
    # CLI check: depois exige --antes e compara.
    with tempfile.TemporaryDirectory() as d:
        a, b = pathlib.Path(d, "a.json"), pathlib.Path(d, "b.json")
        a.write_text(json.dumps(_row()), encoding="utf-8")
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            assert c.main(["check", "--fase", "antes", str(a)]) == 0
        resumo = [l[len("RESUMO="):] for l in buf.getvalue().splitlines() if l.startswith("RESUMO=")][0]
        b.write_text(resumo, encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            assert c.main(["check", "--fase", "depois", str(a)]) == 1, "depois sem --antes"
            assert c.main(["check", "--fase", "depois", "--antes", str(b), str(a)]) == 0
            b.write_text(json.dumps(dict(json.loads(resumo), diario_head=2)), encoding="utf-8")
            assert c.main(["check", "--fase", "depois", "--antes", str(b), str(a)]) == 1
            b.write_text("", encoding="utf-8")
            assert c.main(["check", "--fase", "depois", "--antes", str(b), str(a)]) == 1


def check_certify_binding(c):
    def fetch_from(routes, fail=()):
        def fetch(path):
            if path in fail:
                raise c.Inalcancavel("x")
            return json.loads(routes[path][1])["result"]
        return fetch
    r = cf_routes()
    assert c.avalia_binding(fetch_from(r), "presente", SHA_C)[0] == c.PASS
    assert c.avalia_binding(fetch_from(r), "ausente", SHA_C)[0] == c.FAIL
    assert c.avalia_binding(fetch_from(cf_routes(diario=False)), "ausente", SHA_C)[0] == c.PASS
    assert c.avalia_binding(fetch_from(cf_routes(diario=False)), "presente", SHA_C)[0] == c.FAIL
    assert c.avalia_binding(fetch_from(r), "presente", SHA_B)[0] == c.FAIL, "versão ativa precisa ser o candidato"
    assert c.avalia_binding(fetch_from(r), "presente", None)[0] == c.PASS
    assert c.avalia_binding(fetch_from(cf_routes(db="22222222-2222-4222-8222-222222222222")), "presente", SHA_C)[0] == c.FAIL
    parcial = {"deployments": [{"versions": [{"version_id": "v1", "percentage": 50}]}]}
    assert c.avalia_binding(fetch_from(cf_routes(deployments=parcial)), "presente", SHA_C)[0] == c.FAIL
    for fail in ("/deployments", "/versions/v1", "/settings"):
        assert c.avalia_binding(fetch_from(r, {fail}), "presente", SHA_C)[0] == c.NAO_COMPROVADO, fail
    # versão e settings discordam: FAIL.
    rv = cf_routes(diario=False)
    rv["/versions/v1"] = cf_routes()["/versions/v1"]
    assert c.avalia_binding(fetch_from(rv), "ausente", SHA_C)[0] == c.FAIL
    assert c.avalia_binding(fetch_from(rv), "presente", SHA_C)[0] == c.FAIL
    # tipo errado ou dois DIARIO: FAIL.
    rt = cf_routes()
    s = json.loads(rt["/settings"][1])
    s["result"]["bindings"].append({"name": "DIARIO", "type": "d1", "id": DIARIO_WANTED["database_id"]})
    rt["/settings"][1] = json.dumps(s)
    assert c.avalia_binding(fetch_from(rt), "presente", SHA_C)[0] == c.FAIL
    rk = cf_routes()
    s = json.loads(rk["/settings"][1])
    s["result"]["bindings"][-1]["type"] = "kv_namespace"
    rk["/settings"][1] = json.dumps(s)
    assert c.avalia_binding(fetch_from(rk), "presente", SHA_C)[0] == c.FAIL
    # NC-1017-01: com duas fontes exigidas, /versions sem a lista de bindings é NAO_COMPROVADO (fail-closed).
    sem_v = cf_routes(versao_bindings=False)
    assert c.avalia_binding(fetch_from(sem_v), "presente", SHA_C)[0] == c.PASS
    assert c.avalia_binding(fetch_from(sem_v), "presente", SHA_C, duas_fontes=True)[0] == c.NAO_COMPROVADO
    assert c.avalia_binding(fetch_from(sem_v), "ausente", None, duas_fontes=True)[0] == c.NAO_COMPROVADO
    assert c.avalia_binding(fetch_from(r), "presente", SHA_C, duas_fontes=True)[0] == c.PASS
    assert c.avalia_binding(fetch_from(cf_routes(diario=False)), "ausente", None, duas_fontes=True)[0] == c.PASS
    assert c.avalia_binding(fetch_from(rv), "presente", SHA_C, duas_fontes=True)[0] == c.FAIL
    # CLI: --duas-fontes chega à avaliação (curl_get substituído; token e conta falsos).
    import contextlib, io
    old_get, old_env = c.curl_get, {k: os.environ.get(k) for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")}
    c.curl_get = lambda url, token: json.loads(sem_v[next(k for k in sem_v if url.endswith(k))][1])["result"]
    os.environ.update(CLOUDFLARE_API_TOKEN="tok", CLOUDFLARE_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            assert c.main(["binding", "--expect", "presente", "--candidate", SHA_C]) == c.PASS
            assert c.main(["binding", "--expect", "presente", "--candidate", SHA_C, "--duas-fontes"]) == c.NAO_COMPROVADO
    finally:
        c.curl_get = old_get
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    # settings sem lista: não comprovado.
    rn = cf_routes()
    rn["/settings"][1] = json.dumps({"success": True, "result": {}})
    assert c.avalia_binding(fetch_from(rn), "ausente", SHA_C)[0] == c.NAO_COMPROVADO


class DiarioD1CertifyScriptTest(unittest.TestCase):
    def test_esquema_migracoes_e_contagens(self):
        check_certify(_module_from(CERTIFY))

    def test_binding_efetivo(self):
        check_certify_binding(_module_from(CERTIFY))


# --- mutantes: cada um precisa ser pego por pelo menos uma verificação ------------------------------------------
def _sub_text(src, old, new):
    assert src.count(old) >= 1, "mutante não aplicável: " + old[:80]
    return src.replace(old, new, 1)


def _guard_violations(text):
    try:
        pg = _module_from(GUARD, text)
        check_guard(pg)
        check_guard_cli(pg)
        return []
    except Exception as e:  # noqa: BLE001
        return [str(e)[:200] or type(e).__name__]


def _certify_violations(text):
    try:
        c = _module_from(CERTIFY, text)
        check_certify(c)
        check_certify_binding(c)
        return []
    except Exception as e:  # noqa: BLE001
        return [str(e)[:200] or type(e).__name__]


def _generator_violations(text):
    try:
        check_generator_modes(_diario_injector(text))
        return []
    except BaseException as e:  # noqa: BLE001 - SystemExit inesperado também mata
        return [str(e)[:200] or type(e).__name__]


def _workflow_violations(text):
    out = []
    for chk in (check_wf_order_and_wiring, check_wf_modo_validation, check_wf_binding_step, check_wf_postpromo):
        try:
            chk(text)
        except Exception as e:  # noqa: BLE001
            out.append(f"{chk.__name__}: {e}"[:200])
    return out


SCRIPT_MUTANTS = {
    # promotion_guard (NC-P2b-DEP-03)
    "G1 d1-config promove candidato à frente": (GUARD, '        return "refuse", live, "config_only_candidate_not_live"', '        return "promote", live, "config_only_candidate_not_live"'),
    "G2 d1-config com uma fonte só": (GUARD, '    if not (live_http and live_cf):\n        return "refuse", live, "config_only_requires_both_sources"', '    if False:\n        return "refuse", live, "config_only_requires_both_sources"'),
    "G3 d1-config deixa SHA antigo passar": (GUARD, '    if decision != "promote":\n        return "refuse", live, "config_only_" + reason', '    if decision == "refuse":\n        return "refuse", live, "config_only_" + reason'),
    "G4 motivo desconhecido vira rotina": (GUARD, '    if motivo not in MOTIVOS:\n        return "refuse", None, "motivo_invalido"', '    if motivo not in MOTIVOS:\n        motivo = "rotina"'),
    "G5 --motivo ignorado na CLI": (GUARD, "lambda a, b: is_ancestor(a, b, args.repo), args.motivo)", "lambda a, b: is_ancestor(a, b, args.repo))"),
    "G6 rotina mesmo SHA vira skip": (GUARD, '        return "promote", live, "same_as_live_redeploy"', '        return "skip-superseded", live, "same_as_live_redeploy"'),
    # script de certificação (NC-P2b-DEP-02)
    "S1 diario_head não conferido": (CERTIFY, '    if r["diario_head"] != 1:', '    if False:'),
    "S2 migrações não conferidas": (CERTIFY, '    if r["migracoes"] != list(MIGRACOES_ESPERADAS):', '    if not r["migracoes"]:'),
    "S3 objetos: só falta conta (sobra passa)": (CERTIFY, '    if r["objetos"] != esperado:', '    if set(esperado) - set(r["objetos"]):'),
    "S4 abandono com linha passa": (CERTIFY, "        if n != 0:", "        if n not in (0, 1, 2, 3):"),
    "S5 antes x depois não comparados": (CERTIFY, "    if antes is not None:", "    if False:"),
    "S6 migração nova sem revisão aceita": (CERTIFY, "    if achadas != MIGRACOES_ESPERADAS:", "    if False:"),
    "S7 SQL sem gatilhos": (CERTIFY, "where type in ('table', 'index', 'trigger')", "where type in ('table', 'index')"),
    "S8 binding: tag não conferida": (CERTIFY, "    if candidate and tag != candidate.lower():", "    if False:"),
    "S9 binding: ausente aceita presente": (CERTIFY, "            if d:\n", "            if False:\n"),
    "S10 binding: UUID não conferido": (CERTIFY, '            if b.get("type") != "d1" or bid != DB_ID:', '            if b.get("type") != "d1":'),
    "S11 binding: API inalcançável vira PASS": (CERTIFY, '        return NAO_COMPROVADO, f"API inalcançável: {e}", reg', '        return PASS, f"API inalcançável: {e}", reg'),
    "S12 binding: versão a 100% não exigida": (CERTIFY, 'if int(v.get("percentage") or 0) == 100]', "]"),
    "S13 binding: versão e settings não precisam concordar": (CERTIFY, "    for nome, bindings in fontes.items():", "    for nome, bindings in list(fontes.items())[:1]:"),
    "S14 depois com resumo antes vazio passa": (CERTIFY, '            if not isinstance(antes, dict):\n                raise Falha', '            if False:\n                raise Falha'),
    # gerador (NC-P2b-DEP-02: off é o padrão)
    "P1 padrão certificar": (SCRIPT, '    modo = modo or "off"', '    modo = modo or "certificar"'),
    "P2 off injeta": (SCRIPT, '    if modo in ("certificar", "manter"):', '    if modo in ("certificar", "manter", "off"):'),
    "P3 rollback mantém o DIARIO da base": (SCRIPT, '    rest = [row for row in d1 if row.get("binding") != wanted["binding"]]', '    rest = list(d1)'),
    "P4 modo inválido vira off": (SCRIPT, '        raise SystemExit("DIARIO_D1_MODO_INVALIDO " + modo)', '        modo = "off"'),
    "P6 manter não religa o binding": (SCRIPT, '    if modo in ("certificar", "manter"):', '    if modo == "certificar":'),
    "S15 duas fontes ignorado": (CERTIFY, '    if duas_fontes and "versao" not in fontes:', '    if False:'),
    "S16 --duas-fontes não chega à avaliação": (CERTIFY, "args.expect, args.candidate, args.duas_fontes)", "args.expect, args.candidate)"),
    "P5 off sem a recusa do banco de certificação": (SCRIPT, '    d1 = cfg.get("d1_databases") or []\n    for row in d1:', '    d1 = cfg.get("d1_databases") or []\n    for row in []:'),
}
WF_MUTANTS = {
    "W1 padrão inválido aceito": ('if [ "$padrao" = "INVALIDO" ]; then', 'if false; then'),
    "W2 certificar/rollback sem d1-config": ('              if [ "$motivo" != "d1-config" ]; then', '              if false; then'),
    "W3 push com input de modo": ('if [ "$EVENTO" != "workflow_dispatch" ] && {', 'if false && {'),
    "W4 d1-config com off/manter": ('              if [ "$motivo" = "d1-config" ]; then', '              if false; then'),
    "W5 guard sem --motivo": (' --motivo "${PROMOTION_MOTIVO:-rotina}"', ''),
    "W6 job deploy sem o modo": ("\n      DIARIO_D1_MODO: ${{ needs.guard.outputs.diario_d1 }}\n", "\n"),
    "W7 NAO_COMPROVADO aceito fora de off": ('              if [ "$modo" = "off" ]; then\n                echo "::warning title=DIARIO_D1_BINDING_EFETIVO::NAO_COMPROVADO', '              if true; then\n                echo "::warning title=DIARIO_D1_BINDING_EFETIVO::NAO_COMPROVADO'),
    "W8 conferência espera presente em off": ('            off|rollback) esperado="ausente"; fontes="" ;;', '            off|rollback) esperado="presente"; fontes="" ;;'),
    "W9 FAIL do binding não reprova": ('echo "::error title=DIARIO_D1_BINDING_EFETIVO::FAIL: binding DIARIO não está $esperado na versão ativa (diario_d1=$modo); ver DIARIO_D1_BINDING_EFETIVO no log"\n              exit 1', 'echo "::error title=DIARIO_D1_BINDING_EFETIVO::FAIL: binding DIARIO não está $esperado na versão ativa (diario_d1=$modo); ver DIARIO_D1_BINDING_EFETIVO no log"\n              exit 0'),
    "W10 rollback automático sem conferência": ('diario_d1_certify.py binding --expect ausente --duas-fontes ||', 'true ||'),
    "W11 readback depois do rollback automático": ("      - name: P20 diário D1 - readback", "      - name: P20 diario D1 - readback"),
    "W12 certificar/manter com uma fonte só": ('certificar|manter) esperado="presente"; fontes="--duas-fontes" ;;', 'certificar|manter) esperado="presente"; fontes="" ;;'),
    "W13 exceção do pós-promoção em todo modo": ("needs.guard.outputs.diario_d1 == 'certificar' && steps.postpromo.outputs.state == 'NAO_COMPROVADO'", "steps.postpromo.outputs.state == 'NAO_COMPROVADO'"),
    "W14 exceção do pós-promoção não falha": ("rollback automático a seguir (NC-1017-01)\"\n          exit 1", "rollback automático a seguir (NC-1017-01)\"\n          exit 0"),
    "W18 regra geral T1 trocada": ("--verify-promoted --unproven-exit 0 --service zevanory", "--verify-promoted --unproven-exit 2 --service zevanory"),
    "W19 exceção depois do rollback": ("      - name: P20 diário D1 - pós-promoção NAO_COMPROVADO", "      - name: P20 diario D1 - pos-promocao NAO_COMPROVADO"),
    "W15 padrão versionado ignorado": ('if [ -z "$modo" ] || [ "$modo" = "padrao" ]; then modo="$padrao"; fi', 'if [ -z "$modo" ] || [ "$modo" = "padrao" ]; then modo="off"; fi'),
    "W16 risco residual do rollback calado": ('echo "::error title=DIARIO_D1_ROLLBACK_NAO_CONCLUIDO::', 'echo "::notice title=DIARIO_D1_ROLLBACK_NAO_CONCLUIDO::'),
    "W17 manter conferido como ausente": ('certificar|manter) esperado="presente"; fontes="--duas-fontes" ;;', 'certificar) esperado="presente"; fontes="--duas-fontes" ;;\n            manter) esperado="ausente"; fontes="" ;;'),
}


class DiarioD1MutantsTest(unittest.TestCase):
    def test_mutantes_morrem(self):
        sources = {p: p.read_text(encoding="utf-8") for p in (GUARD, CERTIFY, SCRIPT)}
        checker = {GUARD: _guard_violations, CERTIFY: _certify_violations, SCRIPT: _generator_violations}
        wf = WORKFLOW.read_text(encoding="utf-8")
        for p, src in sources.items():
            self.assertEqual(checker[p](src), [], f"{p.name}: a fonte real passa")
        self.assertEqual(_workflow_violations(wf), [], "o workflow real passa")
        survived = []
        for name, (p, old, new) in SCRIPT_MUTANTS.items():
            if not checker[p](_sub_text(sources[p], old, new)):
                survived.append(name)
        for name, (old, new) in WF_MUTANTS.items():
            if not _workflow_violations(_sub_text(wf, old, new)):
                survived.append(name)
        total = len(SCRIPT_MUTANTS) + len(WF_MUTANTS)
        print(f"\nDIARIO_D1_MUTANTS total={total} killed={total - len(survived)} survived={len(survived)}")
        self.assertEqual(survived, [])


if __name__ == "__main__":
    unittest.main()
