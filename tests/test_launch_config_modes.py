#!/usr/bin/env python3
"""Run the REAL launch candidate preparer in sandboxed temporary working directories."""
import json, os, pathlib, subprocess, sys, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy/prepare-central-candidate.py"
HASH = "e" * 16
DEFAULTS = {
    "PUBLIC_OWNER_ACCOUNT_ID": "f" * 32,
    "TARGET_RUNTIME_SHA": "a" * 40
}

def run_case(auth="", collector="", webhook=""):
    with tempfile.TemporaryDirectory(prefix="zevanory-launch-contract-") as td:
        path = pathlib.Path(td)
        (path/"worker").mkdir()
        (path/"public").mkdir()
        (path/"wrangler.central-fix.jsonc").write_text(json.dumps({"vars":{}, "kv_namespaces":[]}), encoding="utf-8")
        (path/"worker/binding-aliases.mjs").write_text("return Reflect.get(target, prop, receiver);\nreturn Reflect.has(target, prop);\n", encoding="utf-8")
        (path/"worker/cloudflare-worker.recovered.mjs").write_text(
            '    }\n    if (provider === "stripe") {\nconst pilotSandbox = Boolean(pilot?.authorized) && String(process.env.CERTIFICATION_PILOT_PAYMENT_MODE || "").toLowerCase() === "sandbox";',
            encoding="utf-8")
        (path/"public/solucoes.html").write_text("<!doctype html><title>Solucoes</title>", encoding="utf-8")
        (path/"public/sitemap.xml").write_text("<urlset></urlset>", encoding="utf-8")
        env = {**os.environ, **DEFAULTS, "ZEVANORY_LAUNCH_AUTHORIZATION":auth,
               "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16":collector,
               "MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED":webhook}
        proc = subprocess.run([sys.executable, str(SCRIPT)], cwd=td, env=env,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        config = json.loads((path/"wrangler.central-fix.jsonc").read_text(encoding="utf-8"))
        return proc.returncode, config["vars"], proc.stdout+proc.stderr

class LaunchConfigModes(unittest.TestCase):
    def test_no_authorization_all_closed_and_sandbox(self):
        code, vars_, _ = run_case()
        self.assertEqual(code, 0)
        for name in ("ABSOLUTE_RELEASE_APPROVED","PRE_SALE_GATES_APPROVED","SALE_GLOBALLY_ENABLED",
                     "CERTIFICATION_PILOT_PRODUCTION_ALLOWED"):
            self.assertEqual(vars_[name], "false", name)
        self.assertEqual(vars_["MERCADOPAGO_ENV"], "sandbox")
        self.assertNotIn("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16", vars_)
        self.assertNotIn("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16", vars_["ZEVANORY_RUNTIME_CONFIG"])
    def test_authorization_missing_collector_hash_fails_closed(self):
        code, _, out = run_case(auth="AUTORIZO COMPRA REAL", collector="", webhook="true")
        self.assertNotEqual(code,0)
        self.assertIn("LAUNCH_COLLECTOR_PROOF_MISSING",out)
    def test_authorization_invalid_hash_fails_closed(self):
        code, _, out = run_case(auth="AUTORIZO COMPRA REAL",collector="invalid!",webhook="true")
        self.assertNotEqual(code,0)
        self.assertIn("LAUNCH_COLLECTOR_PROOF_MISSING",out)
    def test_authorization_missing_webhook_proof_fails_closed(self):
        code, _, out = run_case(auth="AUTORIZO COMPRA REAL",collector=HASH,webhook="")
        self.assertNotEqual(code,0)
        self.assertIn("LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED",out)
    def test_authorization_valid_prepares_production_but_never_opens_sales(self):
        code, vars_, _ = run_case(auth="AUTORIZO COMPRA REAL",collector=HASH,webhook="true")
        self.assertEqual(code,0)
        self.assertEqual(vars_["MERCADOPAGO_ENV"],"production")
        self.assertNotIn("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16",vars_)
        self.assertEqual(vars_["ZEVANORY_RUNTIME_CONFIG"]["MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16"], HASH)
        self.assertEqual(vars_["ABSOLUTE_RELEASE_APPROVED"],"true")
        self.assertEqual(vars_["PRE_SALE_GATES_APPROVED"],"true")
        self.assertEqual(vars_["SALE_GLOBALLY_ENABLED"],"false")
        self.assertEqual(vars_["CERTIFICATION_PILOT_PRODUCTION_ALLOWED"],"false")

if __name__=="__main__":
    unittest.main(verbosity=2)
