#!/usr/bin/env python3
import datetime as dt
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/sales_switch_workflow.py"
spec = importlib.util.spec_from_file_location("sales_switch_workflow", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SalesSwitchWorkflowTests(unittest.TestCase):
    def test_exact_owner_phrase_and_order_reference(self):
        self.assertTrue(mod.validate_ref("https://github.com/arbmsistone-lab/zevanory-public-mirror/issues/123"))
        self.assertFalse(mod.validate_ref("http://github.com/arbmsistone-lab/zevanory-public-mirror/issues/123"))
        self.assertFalse(mod.validate_ref("https://evil.example/arbmsistone-lab/zevanory-public-mirror/issues/123"))
    def test_owner_open_dry_run_never_contacts_network_or_writes_kv(self):
        env = {**os.environ, "CONFIRM":"LIBERAR VENDAS",
               "ORDER_REF":"https://github.com/arbmsistone-lab/zevanory-public-mirror/issues/123",
               "CLOUDFLARE_API_TOKEN":""}
        out = subprocess.run([sys.executable, str(SCRIPT), "open", "--dry-run"], env=env, text=True, capture_output=True)
        self.assertEqual(out.returncode, 0, out.stdout+out.stderr)
        self.assertIn("PASS_NO_KV_WRITE_NO_NETWORK", out.stdout)
    def test_close_dry_run_never_contacts_network_or_writes_kv(self):
        out = subprocess.run([sys.executable, str(SCRIPT), "close", "--dry-run"], text=True, capture_output=True)
        self.assertEqual(out.returncode, 0, out.stdout+out.stderr)
        self.assertIn("PASS_NO_KV_WRITE_NO_NETWORK", out.stdout)
    def test_incorrect_owner_phrase_is_blocked_even_in_dry_run(self):
        env={**os.environ,"CONFIRM":"SIM", "ORDER_REF":"https://github.com/arbmsistone-lab/zevanory-public-mirror/issues/123"}
        out=subprocess.run([sys.executable,str(SCRIPT),"open","--dry-run"],env=env,text=True,capture_output=True)
        self.assertNotEqual(out.returncode,0)
        self.assertIn("OWNER_ORDER_CONFIRMATION_INVALID",out.stdout)
    def test_preflight_eight_of_eight_and_fresh(self):
        checks=[{"id":"C"+str(i),"ok":True} for i in range(8)]
        raw={"ok":True, "at":dt.datetime.now(dt.timezone.utc).isoformat(), "checks":checks}
        self.assertLess(mod.preflight_guard(raw), 60)
        raw["checks"][0]["ok"]=False
        with self.assertRaisesRegex(RuntimeError,"8_OF_8"):
            mod.preflight_guard(raw)
        raw["checks"][0]["ok"]=True
        raw["at"]=(dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=4)).isoformat()
        with self.assertRaisesRegex(RuntimeError,"STALE"):
            mod.preflight_guard(raw)
    def test_deploy_fail_closed_without_official_success(self):
        with patch.dict(os.environ,{"GITHUB_EVENT_NAME":"workflow_dispatch","GITHUB_REF":"refs/heads/gh-pages","GITHUB_SHA":"a"*40,"GH_TOKEN":"dummy"}):
            with patch.object(mod,"github_json",side_effect=[
                {"commit":{"sha":"a"*40}},{"workflow_runs":[{"name":"ZEVANORY central production deploy","head_sha":"a"*40,"conclusion":"failure"}]}]):
                with self.assertRaisesRegex(RuntimeError,"CENTRAL_DEPLOY_NOT_SUCCESS"):
                    mod.production_sha_and_deploy()
    def test_close_has_no_financial_or_deploy_precondition(self):
        source=SCRIPT.read_text()
        chunk=source.split("    else:\n        if args.dry_run:",1)[1]
        self.assertNotIn("production_sha_and_deploy()",chunk)
        self.assertNotIn("preflight_guard(",chunk)
        self.assertIn('kv_write(token, ns, {"enabled": False})',chunk)
    def test_workflow_dispatch_only_for_live_writes(self):
        from pathlib import Path
        o=(ROOT/".github/workflows/zevanory-open-sales.yml").read_text()
        c=(ROOT/".github/workflows/zevanory-close-sales.yml").read_text()
        self.assertIn("workflow_dispatch:",o)
        self.assertIn("workflow_dispatch:",c)
        self.assertIn("default: true",o)
        self.assertIn("refs/heads/gh-pages",o)
        self.assertIn("refs/heads/gh-pages",c)
        self.assertNotIn("schedule:",o)
        self.assertNotIn("push:",o)
        self.assertNotIn("push:",c)

if __name__ == "__main__":
    unittest.main(verbosity=2)
