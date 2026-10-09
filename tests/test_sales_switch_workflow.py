#!/usr/bin/env python3
import datetime as dt
import contextlib
import io
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
        self.assertIn('kv_write(token, ns, {"enabled": False, "at": ISO(), "by": "owner-close"})',chunk)
    def test_close_survives_settings_failure_and_records_owner_audit(self):
        # A failed Worker settings lookup must not prevent the F7 namespace write.
        with patch.dict(os.environ, {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/gh-pages",
            "CLOUDFLARE_API_TOKEN": "test-token",
        }):
            with patch.object(sys, "argv", [str(SCRIPT), "close"]), \
                 patch.object(mod, "request", side_effect=TimeoutError("settings unavailable")) as settings, \
                 patch.object(mod, "kv_write") as write, \
                 patch.object(mod, "await_status", return_value=True) as observed:
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    mod.main()
        settings.assert_called_once()
        write.assert_called_once()
        token, namespace, record = write.call_args.args
        self.assertEqual(token, "test-token")
        self.assertEqual(namespace, mod.EMERGENCY_CLOSE_NAMESPACE)
        self.assertEqual(namespace, "728a45738e4047f29bcb89934fd533c1")
        self.assertIs(record["enabled"], False)
        self.assertEqual(record["by"], "owner-close")
        self.assertRegex(record["at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        observed.assert_called_once_with(False)
        self.assertIn("KNOWN_NAMESPACE_FALLBACK", out.getvalue())
        self.assertIn("CLOSE_SALES=PASS", out.getvalue())

    def test_close_binding_mismatch_cannot_redirect_emergency_write(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "test-token"}):
            with patch.object(mod, "cf_binding", return_value=("test-token", "a"*32)):
                token, namespace = mod.close_binding()
        self.assertEqual(token, "test-token")
        self.assertEqual(namespace, mod.EMERGENCY_CLOSE_NAMESPACE)

    def test_close_requires_cloudflare_write_credential(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": ""}):
            with patch.object(mod, "cf_binding") as settings:
                with self.assertRaisesRegex(RuntimeError, "CLOUDFLARE_TOKEN_UNAVAILABLE"):
                    mod.close_binding()
        settings.assert_not_called()

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


class DeployLookupRegression(unittest.TestCase):
    def test_deploy_lookup_is_workflow_scoped_and_read_cap_is_large(self):
        src = (pathlib.Path(__file__).resolve().parents[1] / "scripts" / "sales_switch_workflow.py").read_text()
        self.assertIn("/actions/workflows/central-production-deploy.yml/runs?head_sha=", src)
        self.assertNotIn('"/actions/runs?head_sha="', src)
        self.assertIn("resp.read(4 * 1024 * 1024)", src)
