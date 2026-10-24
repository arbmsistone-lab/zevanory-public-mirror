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


if __name__ == "__main__":
    unittest.main()
