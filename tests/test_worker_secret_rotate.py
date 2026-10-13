"""T3 (#802): scripts/deploy/worker_secret_rotate.py against a simulated Cloudflare account.

Models versions (code SHA tag + secret names), the active deployment, the public readback and
/api/health, and executes the script's real wrangler argument lists through a fake runner.
"""
import importlib.util
import json
import os
import pathlib
import stat
import sys
import unittest
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "deploy"))
spec = importlib.util.spec_from_file_location("worker_secret_rotate", ROOT / "scripts" / "deploy" / "worker_secret_rotate.py")
wsr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wsr)
pg = wsr.pg

L = "a" * 40          # live SHA
CHILD = "b" * 40      # next code commit (descendant of L)
NEW_KEY, OLD_KEY = "N" * 40, "O" * 40


class World:
    def __init__(self):
        self.versions = {"v1": {"tag": L, "secrets": {"RESEND_API_KEY"}}}
        self.order = ["v1"]          # newest first
        self.active = "v1"
        self.deployed = ["v1"]       # every version that ever served 100%
        self.readback = L
        self.healthy = True
        self.cf_down = False
        self.health_mode = "ok"      # ok | timeout | http503
        self.secrets_mode = "ok"     # ok | down | success_false | hide:<NAME>
        self.calls = []
        self.bulk_files_mode = []

    # fetch(url, headers) used by promotion_guard and the script
    def fetch(self, url, headers=None):
        if "api.cloudflare.com" in url:
            if self.cf_down:
                raise urllib.error.URLError("cloudflare down")
            if url.endswith("/deployments"):
                return {"success": True, "result": {"deployments": [{"versions": [{"version_id": self.active, "percentage": 100}]}]}}
            if url.endswith("/versions"):
                return {"success": True, "result": {"items": [{"id": v} for v in self.order]}}
            if "/versions/" in url:
                vid = url.rsplit("/", 1)[1]
                tag = self.versions[vid]["tag"]
                return {"success": True, "result": {"metadata": {"annotations": ({"workers/tag": tag} if tag else {})}}}
            if url.endswith("/secrets"):
                if self.secrets_mode == "down":
                    raise urllib.error.URLError("secrets api timeout")
                if self.secrets_mode == "success_false":
                    return {"success": False, "errors": [{"code": 10000}]}
                hidden = self.secrets_mode.split(":", 1)[1] if self.secrets_mode.startswith("hide:") else None
                return {"success": True, "result": [{"name": n, "type": "secret_text"} for n in sorted(self.versions[self.active]["secrets"]) if n != hidden]}
        if url.endswith("/api/release"):
            return {"deployment": {"commit_sha": self.readback}}
        if url.endswith("/api/health"):
            if self.active != "v1" and self.health_mode == "timeout":
                raise TimeoutError("health timeout")
            if self.active != "v1" and self.health_mode == "http503":
                raise urllib.error.HTTPError(url, 503, "unavailable", {}, None)
            return {"live": self.healthy, "ready": self.healthy}
        raise AssertionError("unexpected url " + url)

    def run(self, cmd, capture_output=True, text=True, input=None):
        args = cmd[cmd.index("versions"):]
        self.calls.append(args)
        tag = args[args.index("--tag") + 1] if "--tag" in args else None
        base = dict(self.versions[self.order[0]])
        if args[:3] == ["versions", "secret", "bulk"]:
            path = pathlib.Path(args[3])
            self.bulk_files_mode.append(stat.S_IMODE(os.stat(path).st_mode))
            names = set(json.loads(path.read_text()))
            self._new({"tag": tag, "secrets": set(base["secrets"]) | names})
        elif args[:3] == ["versions", "secret", "delete"]:
            self._new({"tag": tag, "secrets": set(base["secrets"]) - {args[3]}})
        elif args[:2] == ["versions", "deploy"]:
            self.active = args[2].split("@")[0]
            self.deployed.append(self.active)
        else:
            raise AssertionError(args)
        return type("P", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def _new(self, version):
        vid = f"v{len(self.versions) + 1}"
        self.versions[vid] = version
        self.order.insert(0, vid)


class Rotate(unittest.TestCase):
    def setUp(self):
        os.environ["CLOUDFLARE_API_TOKEN"] = "t"
        os.environ["CLOUDFLARE_ACCOUNT_ID"] = "acc"
        self.w = World()
        self.cf = wsr.Cloudflare(fetch=self.w.fetch)

    def go(self, keys, **kw):
        import contextlib, io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = wsr.run(keys, cf=self.cf, run_cmd=self.w.run, fetch=self.w.fetch, attempts=2, interval=0, sleep=lambda s: None, **kw)
        self.out = out.getvalue()
        return code

    def test_first_copy_one_tagged_version_and_both_sources_after(self):
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 0, self.out)
        self.assertEqual([c[:3] for c in self.w.calls], [["versions", "secret", "bulk"], ["versions", "deploy", "v2@100%"]])
        self.assertEqual(self.w.versions["v2"]["tag"], L, "secret version keeps the live SHA tag")
        self.assertEqual(self.w.bulk_files_mode, [0o600], "key file readable only by the runner user")
        self.assertIn("LEAD_PRIVACY_SECRET", self.w.versions[self.w.active]["secrets"])
        self.assertNotIn(NEW_KEY, self.out, "value never printed")
        # Point 2: the NEXT code publication still sees both sources and stays monotonic.
        ancestor = lambda a, b: (a, b) in {(L, CHILD)} or a == b
        live_http = pg.readback_sha(wsr.RELEASE_URL, wsr.RELEASE_PATH, self.w.fetch)
        live_cf = pg.cloudflare_sha(wsr.SCRIPT, self.w.fetch)
        self.assertEqual((live_http, live_cf), (L, L))
        self.assertEqual(pg.decide(CHILD, live_http, live_cf, ancestor), ("promote", L, "forward_of_live"))
        self.assertEqual(pg.decide("c" * 40, live_http, live_cf, ancestor)[0], "refuse", "diverged still refused")

    def test_contrast_untagged_secret_put_would_drop_the_cloudflare_source(self):
        # What `wrangler secret put` produces: same code, NO tag -> the guard silently loses a source.
        self.w._new({"tag": None, "secrets": {"X"}}); self.w.active = self.w.order[0]
        self.assertEqual(pg.observe_cloudflare(wsr.SCRIPT, self.w.fetch), ("answered", None))
        self.assertIsNone(pg.cloudflare_sha(wsr.SCRIPT, self.w.fetch))
        # ...and this script refuses to build on such a state (both sources required).
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 1)
        self.assertEqual(self.w.calls, [], "no change when the effective version is not proven by both sources")

    def test_rotation_has_no_intermediate_state(self):
        self.go({"LEAD_PRIVACY_SECRET": OLD_KEY})
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY, "LEAD_PRIVACY_SECRET_PREVIOUS": OLD_KEY}), 0, self.out)
        bulk = [c for c in self.w.calls if c[:3] == ["versions", "secret", "bulk"]]
        self.assertEqual(len(bulk), 2, "one bulk upload per run, never one per key")
        # Every version that ever served traffic during the rotation has CURRENT, and the rotated one has both.
        for vid in self.w.deployed[1:]:
            self.assertIn("LEAD_PRIVACY_SECRET", self.w.versions[vid]["secrets"], vid)
        self.assertTrue({"LEAD_PRIVACY_SECRET", "LEAD_PRIVACY_SECRET_PREVIOUS"} <= self.w.versions[self.w.active]["secrets"])
        # End of rotation: PREVIOUS removed in one tagged version, CURRENT kept.
        self.assertEqual(self.go({}, drop=("LEAD_PRIVACY_SECRET_PREVIOUS",)), 0, self.out)
        active = self.w.versions[self.w.active]
        self.assertEqual(active["tag"], L)
        self.assertIn("LEAD_PRIVACY_SECRET", active["secrets"]); self.assertNotIn("LEAD_PRIVACY_SECRET_PREVIOUS", active["secrets"])

    def test_precheck_refuses_disagreement_or_pending_version(self):
        self.w.readback = CHILD
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 1); self.assertEqual(self.w.calls, [])
        self.w.readback = L
        self.w._new({"tag": CHILD, "secrets": set()})  # uploaded but not deployed
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 1)
        self.assertEqual(self.w.calls, [], "a pending version would otherwise be the base of the new one")

    def test_post_check_fail_restores_previous_version(self):
        real = self.w.run
        def run(cmd, **kw):
            r = real(cmd, **kw)
            if cmd[cmd.index("versions"):][:2] == ["versions", "deploy"] and self.w.active != "v1":
                self.w.readback = CHILD  # positive evidence: the public surface reports another SHA
            return r
        code = wsr.run({"LEAD_PRIVACY_SECRET": NEW_KEY}, cf=self.cf, run_cmd=run, fetch=self.w.fetch, attempts=2, interval=0, sleep=lambda s: None)
        self.assertEqual(code, 1)
        self.assertEqual(self.w.active, "v1", "previous version restored at 100%")

    def test_unhealthy_after_deploy_restores_previous_version(self):
        real = self.w.run
        def run(cmd, **kw):
            r = real(cmd, **kw)
            if self.w.active != "v1":
                self.w.healthy = False
            return r
        self.assertEqual(wsr.run({"LEAD_PRIVACY_SECRET": NEW_KEY}, cf=self.cf, run_cmd=run, fetch=self.w.fetch, attempts=2, interval=0, sleep=lambda s: None), 1)
        self.assertEqual(self.w.active, "v1")

    def test_observer_unreachable_after_deploy_is_not_rolled_back(self):
        real = self.w.run
        def run(cmd, **kw):
            r = real(cmd, **kw)
            if cmd[cmd.index("versions"):][:2] == ["versions", "deploy"]:
                self.w.cf_down = True
            return r
        self.assertEqual(wsr.run({"LEAD_PRIVACY_SECRET": NEW_KEY}, cf=self.cf, run_cmd=run, fetch=self.w.fetch, attempts=2, interval=0, sleep=lambda s: None), 2)
        self.assertNotEqual(self.w.active, "v1", "no rollback on an observability gap")
        self.assertEqual(sum(1 for c in self.w.calls if c[:2] == ["versions", "deploy"]), 1)

    def test_verify_is_read_only(self):
        import contextlib, io
        self.go({"LEAD_PRIVACY_SECRET": NEW_KEY})
        calls = len(self.w.calls)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(wsr.verify(self.cf, self.w.fetch), 0)
        self.assertEqual(len(self.w.calls), calls)
        self.w.healthy = False
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(wsr.verify(self.cf, self.w.fetch), 1)

    # --- Observability classification (FAIL = positive evidence; NAO_COMPROVADO = observer failed) ---
    def test_health_timeout_is_unproven_not_rolled_back(self):
        self.w.health_mode = "timeout"
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 2, self.out)
        self.assertIn('"state": "NAO_COMPROVADO"', self.out); self.assertIn("health_unreachable", self.out)
        self.assertEqual(self.w.active, "v2", "version preserved")
        self.assertEqual(sum(1 for c in self.w.calls if c[:2] == ["versions", "deploy"]), 1, "no rollback deploy")

    def test_health_http_error_is_failure_and_rolled_back(self):
        self.w.health_mode = "http503"
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 1, self.out)
        self.assertIn("health_answered_not_live_ready", self.out)
        self.assertEqual(self.w.active, "v1")

    def test_secrets_api_down_is_unproven_not_rolled_back(self):
        self.w.secrets_mode = "down"
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 2, self.out)
        self.assertIn("secrets_api_unreadable", self.out)
        self.assertEqual(self.w.active, "v2")

    def test_secrets_api_success_false_is_unproven(self):
        self.w.secrets_mode = "success_false"
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 2, self.out)
        self.assertEqual(self.w.active, "v2")

    def test_binding_listed_and_missing_is_failure_and_rolled_back(self):
        self.w.secrets_mode = "hide:LEAD_PRIVACY_SECRET"
        self.assertEqual(self.go({"LEAD_PRIVACY_SECRET": NEW_KEY}), 1, self.out)
        self.assertIn("missing=LEAD_PRIVACY_SECRET", self.out)
        self.assertEqual(self.w.active, "v1")

    def test_verify_classifies_unreachable_as_unproven(self):
        import contextlib, io
        self.go({"LEAD_PRIVACY_SECRET": NEW_KEY})
        for mode, attr, expected in [("timeout", "health_mode", 2), ("down", "secrets_mode", 2), ("http503", "health_mode", 1)]:
            self.w.health_mode, self.w.secrets_mode = "ok", "ok"
            setattr(self.w, attr, mode)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(wsr.verify(self.cf, self.w.fetch), expected, mode)


if __name__ == "__main__":
    unittest.main()
