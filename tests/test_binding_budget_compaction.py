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


def build_candidate(tmp, script_text, base_mutator=None):
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
    env = {k: v for k, v in os.environ.items() if k not in ("ZEVANORY_LAUNCH_AUTHORIZATION", "OPERATOR_TOKEN_MIGRATION_UNTIL")}
    env.update(PUBLIC_OWNER_ACCOUNT_ID="0" * 32, TARGET_RUNTIME_SHA="a" * 40, PYTHONDONTWRITEBYTECODE="1")
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
# P20 diário D1 (PR2, docs/p20/diario-d1.md, seção "Binding e migração"): o gerador injeta o binding DIARIO do banco
# de produção zevanory-diario-p20. Prova com o gerador REAL sobre a base fixada: binding presente, id exato, recusa do
# banco de certificação (7ff006f3) e de um DIARIO divergente, e orçamento de bindings inalterado (D1 não é var/secret).
DIARIO_WANTED = {
    "binding": "DIARIO",
    "database_name": "zevanory-diario-p20",
    "database_id": "1b1bfa19-ccc5-423a-bc1f-62d89020c8e2",
    "migrations_dir": "migrations/d1",
}
CERT_D1_ID = "7ff006f3-1daf-44c5-9494-aabab600608e"


def _diario_injector():
    """Extrai do gerador real a constante e a função de injeção (sem rodar o resto do script)."""
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    names = {"DIARIO_D1_BINDING", "DIARIO_D1_FORBIDDEN_PREFIX", "_inject_diario_d1"}
    body = [n for n in tree.body if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in n.targets))
            or (isinstance(n, ast.FunctionDef) and n.name in names)]
    ns = {}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(SCRIPT), "exec"), ns)
    return ns


class DiarioD1BindingUnitTest(unittest.TestCase):
    def setUp(self):
        self.ns = _diario_injector()

    def test_constante_documentada_e_exata(self):
        self.assertEqual(self.ns["DIARIO_D1_BINDING"], DIARIO_WANTED)
        self.assertEqual(self.ns["DIARIO_D1_FORBIDDEN_PREFIX"], "7ff006f3")
        self.assertTrue((ROOT / "migrations/d1/0001_diario_v1.sql").is_file(), "migrations_dir aponta para a migração real")
        doc = (ROOT / "docs/p20/diario-d1.md").read_text(encoding="utf-8")
        self.assertIn("## Binding e migração", doc)
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


@unittest.skipUnless(_base_available(), "deploy base 83620c6 not in this checkout (CI fetches it before this step)")
class DiarioD1BindingGeneratorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg, out = build_candidate(pathlib.Path(cls.tmp, "g"), SCRIPT.read_text(encoding="utf-8"))
        assert cls.cfg, out[-600:]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_binding_presente_com_id_exato(self):
        d1 = self.cfg["d1_databases"]
        self.assertEqual(d1, [DIARIO_WANTED], "a base 83620c6 não tem D1; o único é o DIARIO")
        self.assertFalse(any(str(r.get("database_id", "")).startswith("7ff006f3") for r in d1))
        self.assertNotIn("DIARIO", self.cfg["vars"])
        self.assertNotIn(DIARIO_WANTED["database_id"], json.dumps(self.cfg["vars"]), "o UUID não vai em var")

    def test_orcamento_de_bindings_inalterado(self):
        # Mesmo cenário do teste da vaga P20: hoje 59/60 com P20_BACKUP_KEY. O D1 não conta.
        n_vars = len(self.cfg["vars"])
        secrets = [f"SYNTHETIC_SECRET_{i:02d}" for i in range(60 - n_vars - 1 - 2)] + ["P20_BACKUP_KEY"]
        sem_d1 = {k: v for k, v in self.cfg.items() if k != "d1_databases"}
        self.assertEqual(budget(self.cfg, secrets), (0, 59))
        self.assertEqual(budget(sem_d1, secrets), budget(self.cfg, secrets))

    def test_recusa_certificacao_na_base(self):
        def cert(base):
            base["d1_databases"] = [{"binding": "MAIN_DB", "database_id": CERT_D1_ID}]
        with tempfile.TemporaryDirectory() as d:
            cfg, out = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), cert)
        self.assertIsNone(cfg)
        self.assertIn("DIARIO_D1_CERTIFICATION_DATABASE_FORBIDDEN", out)

    def test_recusa_diario_divergente_na_base(self):
        def other(base):
            base["d1_databases"] = [dict(DIARIO_WANTED, database_id="22222222-2222-4222-8222-222222222222")]
        with tempfile.TemporaryDirectory() as d:
            cfg, out = build_candidate(d, SCRIPT.read_text(encoding="utf-8"), other)
        self.assertIsNone(cfg)
        self.assertIn("DIARIO_D1_BINDING_CONFLICT", out)



WORKFLOW = ROOT / ".github/workflows/central-production-deploy.yml"
FAKE_CURL = r"""#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
[ -n "$out" ] && printf '%s' "$FAKE_CURL_BODY" > "$out"
printf '%s' "$FAKE_CURL_CODE"
"""
FAKE_NPX = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_NPX_LOG"
printf '%s\n' "$FAKE_NPX_OUT"
exit "${FAKE_NPX_RC:-0}"
"""


def workflow_step(name_prefix):
    """Devolve (índice, texto do run) do passo do job deploy cujo nome começa com name_prefix, sem depender de PyYAML."""
    lines = WORKFLOW.read_text(encoding="utf-8").split("\n")
    names = [i for i, l in enumerate(lines) if l.startswith("      - name: ")]
    start = [i for i in names if lines[i][len("      - name: "):].startswith(name_prefix)]
    assert len(start) == 1, (name_prefix, start)
    i = start[0]
    end = next((j for j in names if j > i), len(lines))
    block = lines[i:end]
    r = next(k for k, l in enumerate(block) if l.strip() == "run: |")
    body = [l[10:] if l.startswith(" " * 10) else l.strip() for l in block[r + 1:]]
    return i, "\n".join(body), "\n".join(block)


class DiarioD1WorkflowStepTest(unittest.TestCase):
    """Executa o texto REAL dos dois passos novos do deploy central com curl e npx falsos (nada sai da máquina).
    DEC-P20-D1-01: os passos usam os tokens D1 dedicados (aqui com valores falsos); o isolamento das credenciais,
    o env efetivo de cada passo e os mutantes ficam em tests/test_diario_d1_credentials.py."""

    def run_step(self, prefix, cfg, curl_code="200", curl_body=None, npx_rc=0, npx_out="", extra_env=None):
        _, script, _ = workflow_step(prefix)
        d = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        binp = d / "bin"
        binp.mkdir()
        for n, body in (("curl", FAKE_CURL), ("npx", FAKE_NPX)):
            (binp / n).write_text(body, encoding="utf-8")
            (binp / n).chmod(0o755)
        (d / "wrangler.central-fix.jsonc").write_text(json.dumps(cfg), encoding="utf-8")
        out = d / "gh_output"
        out.write_text("", encoding="utf-8")
        body = curl_body if curl_body is not None else json.dumps({"success": True, "result": {"name": "zevanory-diario-p20"}})
        env = dict(os.environ, PATH=f"{binp}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out), CLOUDFLARE_API_TOKEN="",
                   CF_TOKEN_D1_DIARIO_MIGRATE="fake-d1-migrate", CF_TOKEN_D1_DIARIO_READ="fake-d1-read",
                   PUBLIC_OWNER_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb", FAKE_CURL_CODE=curl_code, FAKE_CURL_BODY=body,
                   FAKE_NPX_RC=str(npx_rc), FAKE_NPX_OUT=npx_out, FAKE_NPX_LOG=str(d / "npx.log"), **(extra_env or {}))
        r = subprocess.run(["bash", "-c", script], cwd=d, env=env, capture_output=True, text=True, timeout=60)
        state = [l.split("=", 1)[1] for l in out.read_text(encoding="utf-8").split("\n") if l.startswith("state=")]
        npx = (d / "npx.log").read_text(encoding="utf-8") if (d / "npx.log").exists() else ""
        return r, (state[-1] if state else None), json.loads((d / "wrangler.central-fix.jsonc").read_text(encoding="utf-8")), npx

    def cfg(self):
        return {"name": "zevanory", "d1_databases": [dict(DIARIO_WANTED)]}

    MIG = "P20 diário D1 - migrações"
    READ = "P20 diário D1 - readback"

    def test_ordem_e_comandos(self):
        mig_i, mig, mig_block = workflow_step(self.MIG)
        dep_i, _, _ = workflow_step("Deploy repaired production worker")
        rb_i, rb, rb_block = workflow_step(self.READ)
        self.assertLess(mig_i, dep_i, "a migração vem ANTES do wrangler deploy")
        self.assertGreater(rb_i, dep_i, "o readback vem depois do deploy")
        self.assertIn('CLOUDFLARE_API_TOKEN="$CF_TOKEN_D1_DIARIO_MIGRATE" npx --yes wrangler@4.143.0 d1 migrations apply zevanory-diario-p20 --remote --config wrangler.central-fix.jsonc', mig)
        self.assertIn('--command "select count(*) as n from diario_head"', rb)
        self.assertIn("continue-on-error: true", rb_block)
        for block, own in ((mig_block, "CF_TOKEN_D1_DIARIO_MIGRATE"), (rb_block, "CF_TOKEN_D1_DIARIO_READ")):
            # DEC-P20-D1-01: cada passo recebe SÓ o seu segredo dedicado (detalhe em tests/test_diario_d1_credentials.py).
            self.assertEqual(re.findall(r"secrets\.([A-Z0-9_]+)", block), [own], "só o segredo dedicado do passo")
            self.assertNotRegex(block, r"d1 (execute|migrations apply) zevanory-certification-only|7ff006f3")
        self.assertNotRegex(rb, r"(?i)\b(insert|update|delete|drop|create|alter)\b", "readback somente leitura")
        self.assertIn('- "migrations/d1/**"', WORKFLOW.read_text(encoding="utf-8"))

    def test_migracao_aplicada(self):
        r, state, cfg, npx = self.run_step(self.MIG, self.cfg(), npx_out="✅ 0001_diario_v1.sql")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(state, "aplicada")
        self.assertEqual(cfg["d1_databases"], [DIARIO_WANTED])
        self.assertIn("d1 migrations apply zevanory-diario-p20 --remote", npx)

    def test_token_sem_d1_na_migracao_avisa_e_segue(self):
        r, state, cfg, _ = self.run_step(self.MIG, self.cfg(), npx_rc=1, npx_out="✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]")
        self.assertEqual(r.returncode, 0)
        self.assertIn("::warning title=DIARIO_D1_MIGRACAO_PENDENTE::", r.stdout)
        self.assertIn("D1 > Editar", r.stdout)
        self.assertEqual(state, "pendente")
        self.assertEqual(cfg["d1_databases"], [DIARIO_WANTED], "binding mantido: a sombra tolera a tabela ausente")

    def test_token_sem_leitura_do_banco_tira_o_binding_e_segue(self):
        r, state, cfg, npx = self.run_step(self.MIG, self.cfg(), curl_code="403", curl_body='{"success":false}')
        self.assertEqual(r.returncode, 0)
        self.assertIn("::warning title=DIARIO_D1_MIGRACAO_PENDENTE::", r.stdout)
        self.assertEqual(state, "binding_removido")
        self.assertNotIn("d1_databases", cfg)
        self.assertEqual(npx, "", "sem acesso ao banco, nem tenta migrar")

    def test_banco_divergente_tira_o_binding(self):
        r, state, cfg, _ = self.run_step(self.MIG, self.cfg(), curl_body='{"success":true,"result":{"name":"outro"}}')
        self.assertEqual(r.returncode, 0)
        self.assertEqual(state, "binding_removido")
        self.assertNotIn("d1_databases", cfg)

    def test_outra_falha_anota_erro_sem_reprovar(self):
        r, state, _, _ = self.run_step(self.MIG, self.cfg(), npx_rc=1, npx_out="SQLITE_ERROR: near x: syntax error")
        self.assertEqual(r.returncode, 0)
        self.assertIn("::error title=DIARIO_D1_MIGRACAO_FALHOU::", r.stdout)
        self.assertEqual(state, "pendente")

    def test_banco_inesperado_no_candidato_reprova(self):
        for cfg in ({"d1_databases": [dict(DIARIO_WANTED, database_id=CERT_D1_ID)]}, {"name": "zevanory"}):
            r, _, _, npx = self.run_step(self.MIG, cfg)
            self.assertEqual(r.returncode, 1)
            self.assertIn("::error title=DIARIO_D1_BINDING::", r.stdout)
            self.assertEqual(npx, "")

    def test_readback_nunca_reprova(self):
        ok = json.dumps([{"results": [{"n": 1}], "success": True}])
        r, _, _, npx = self.run_step(self.READ, self.cfg(), npx_out=ok, extra_env={"DIARIO_MIG_STATE": "aplicada"})
        self.assertEqual(r.returncode, 0)
        self.assertIn("::notice title=DIARIO_D1_READBACK::diario_head presente (linhas=1)", r.stdout)
        self.assertIn("d1 execute zevanory-diario-p20 --remote", npx)
        r, _, _, _ = self.run_step(self.READ, self.cfg(), npx_rc=1, npx_out="no such table: diario_head", extra_env={"DIARIO_MIG_STATE": "pendente"})
        self.assertEqual(r.returncode, 0)
        self.assertIn("::warning title=DIARIO_D1_READBACK::", r.stdout)
        r, _, _, npx = self.run_step(self.READ, self.cfg(), extra_env={"DIARIO_MIG_STATE": "binding_removido"})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(npx, "")


if __name__ == "__main__":
    unittest.main()
