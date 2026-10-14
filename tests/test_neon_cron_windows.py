#!/usr/bin/env python3
"""Neon window crons: run the REAL central preparer against the real pinned base shape and against
unexpected shapes. The cron list is replaced only from a known shape; anything else fails."""
import json, os, pathlib, subprocess, sys, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy/prepare-central-candidate.py"
EXPECTED = ["15,45 * * * *", "16,46 * * * *", "17 * * * *"]
ENV = {"PUBLIC_OWNER_ACCOUNT_ID": "f" * 32, "TARGET_RUNTIME_SHA": "a" * 40,
       "ZEVANORY_LAUNCH_AUTHORIZATION": "", "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16": "", "MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED": ""}

def run(base):
    with tempfile.TemporaryDirectory(prefix="zevanory-neon-cron-") as td:
        path = pathlib.Path(td)
        (path / "worker").mkdir(); (path / "public").mkdir()
        (path / "wrangler.central-fix.jsonc").write_text(json.dumps(base), encoding="utf-8")
        (path / "worker/binding-aliases.mjs").write_text("return Reflect.get(target, prop, receiver);\nreturn Reflect.has(target, prop);\n", encoding="utf-8")
        (path / "worker/cloudflare-worker.recovered.mjs").write_text(
            '    }\n    if (provider === "stripe") {\nconst pilotSandbox = Boolean(pilot?.authorized) && String(process.env.CERTIFICATION_PILOT_PAYMENT_MODE || "").toLowerCase() === "sandbox";\\nconst commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;',
            encoding="utf-8")
        (path / "public/solucoes.html").write_text("<!doctype html><title>Solucoes</title>", encoding="utf-8")
        (path / "public/sitemap.xml").write_text("<urlset></urlset>", encoding="utf-8")
        proc = subprocess.run([sys.executable, str(SCRIPT)], cwd=td, env={**os.environ, **ENV},
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        cfg = json.loads((path / "wrangler.central-fix.jsonc").read_text(encoding="utf-8"))
        return proc.returncode, cfg, proc.stdout + proc.stderr

BASE = {"name": "zevanory", "vars": {}, "kv_namespaces": []}

class NeonCronWindows(unittest.TestCase):
    def test_pinned_base_shape_becomes_exactly_three_window_crons(self):
        code, cfg, out = run({**BASE, "triggers": {"crons": ["0 * * * *"]}})
        self.assertEqual(code, 0, out)
        self.assertEqual(cfg["triggers"]["crons"], EXPECTED)

    def test_minimal_fixture_without_triggers_and_rerun_are_accepted(self):
        for base in (BASE, {**BASE, "triggers": {"crons": []}}, {**BASE, "triggers": {"crons": EXPECTED}}):
            code, cfg, out = run(base)
            self.assertEqual(code, 0, out)
            self.assertEqual(cfg["triggers"]["crons"], EXPECTED)

    def test_unexpected_base_fails_instead_of_being_silently_replaced(self):
        for crons in (["0 * * * *", "30 * * * *"], ["*/5 * * * *"], ["0 * * * *", "15,45 * * * *"], "0 * * * *"):
            code, _, out = run({**BASE, "triggers": {"crons": crons}})
            self.assertNotEqual(code, 0, crons)
            self.assertIn("CRON_BASE_UNEXPECTED", out)
        code, _, out = run({**BASE, "triggers": {"crons": ["0 * * * *"], "queue": "x"}})
        self.assertNotEqual(code, 0); self.assertIn("extra trigger keys", out)

    def test_real_pinned_base_matches_the_known_shape_when_history_is_available(self):
        proc = subprocess.run(["git", "show", "83620c680958d726fc4b0fd16e2574cdcc362a6d:wrangler.jsonc"], cwd=ROOT,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0:
            self.skipTest("pinned commit not in this checkout (shallow clone); the deploy itself enforces the shape")
        base = json.loads(proc.stdout)
        self.assertEqual(base.get("triggers", {}).get("crons"), ["0 * * * *"])
        code, cfg, out = run({**BASE, "triggers": base["triggers"]})
        self.assertEqual(code, 0, out); self.assertEqual(cfg["triggers"]["crons"], EXPECTED)

if __name__ == "__main__":
    unittest.main()
