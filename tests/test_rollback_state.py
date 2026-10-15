"""C-2026-10-15-40: rollback (A) and health (B) reported separately; no failure becomes success."""
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vrs", ROOT / "scripts/deploy/verify-rollback-state.py")
vrs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vrs)

PREV = "9e426ffc996a3b01422d21fe9085b103e46d31f6"
CAND = "55d905a1336a2d0b5019657d100550878f4fc08b"
OTHER = "c431a60c4964e05a8da43676d16d318ecef9a77e"
V_PREV, V_CAND, V_OTHER = "3700ad7a-892b-4510-aa7a-9bb8afc0b2e4", "c76ff576-2a45-4068-9037-bec4bb072225", "78c1c07b-ffbd-4901-9c4e-48a857c93005"
TAGS = {V_PREV: PREV, V_CAND: CAND, V_OTHER: OTHER}


def deps(*active_versions, extra_older=True):
    """Same shape as the Cloudflare response read on 15/10 (newest deployment = active)."""
    d = [{"id": "645a43e2", "created_on": "2026-10-15T16:37:56.360629Z", "versions": [{"version_id": v, "percentage": p} for v, p in active_versions]}]
    if extra_older:
        d.append({"id": "b99e8d2c", "created_on": "2026-10-15T16:34:30.706203Z", "versions": [{"version_id": V_CAND, "percentage": 100}]})
    return {"success": True, "result": {"deployments": d}}


def rel(sha):
    return {"deployment": {"environment": "production", "branch": "gh-pages", "commit_sha": sha}}


HEALTHY = {"live": True, "ready": True}
NEON_DOWN = {"live": True, "ready": False, "checks": {"database_reachable": False}}


class RollbackState(unittest.TestCase):
    def a(self, *args):
        return vrs.rollback_state(*args)[0]

    def test_01_complete_and_healthy(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), TAGS, rel(PREV)), "COMPLETE")
        self.assertEqual(vrs.health_state("200", HEALTHY, "HEALTHY"), "HEALTHY")

    def test_02_complete_with_neon_already_down(self):  # the 15/10 incident, as it really happened
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), TAGS, rel(PREV)), "COMPLETE")
        self.assertEqual(vrs.health_state("503", NEON_DOWN, "DEGRADED_PREEXISTING"), "DEGRADED_PREEXISTING")

    def test_03_incomplete_candidate_still_active(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_CAND, 100)), TAGS, rel(CAND)), "INCOMPLETE")

    def test_04_divergent_active_version(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_OTHER, 100)), TAGS, rel(OTHER)), "DIVERGENT")
        # Cloudflare says previous, the running service says something else: not complete
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), TAGS, rel(OTHER)), "DIVERGENT")
        # a third version is active even though the readback (e.g. a stale edge) still shows previous
        self.assertEqual(self.a(PREV, CAND, deps((V_OTHER, 100)), TAGS, rel(PREV)), "DIVERGENT")

    def test_05_cloudflare_query_failure_is_unverified(self):
        for broken in (None, {}, {"success": False, "errors": [{"code": 10000}]}, {"result": {"deployments": []}}):
            self.assertEqual(self.a(PREV, CAND, broken, TAGS, rel(PREV)), "UNVERIFIED")
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), {}, rel(PREV)), "UNVERIFIED")  # tag unreadable

    def test_06_split_traffic_is_incomplete(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 90), (V_CAND, 10)), TAGS, rel(PREV)), "INCOMPLETE")
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 99)), TAGS, rel(PREV)), "INCOMPLETE")

    def test_07_later_neon_recovery(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), TAGS, rel(PREV)), "COMPLETE")
        self.assertEqual(vrs.health_state("200", HEALTHY, "DEGRADED_PREEXISTING"), "HEALTHY")

    def test_08_new_degradation_is_not_preexisting(self):
        for pre in ("HEALTHY", "UNKNOWN", ""):
            self.assertEqual(vrs.health_state("503", NEON_DOWN, pre), "DEGRADED_NEW")
        self.assertEqual(vrs.health_state("200", {"live": True, "ready": False}, "HEALTHY"), "DEGRADED_NEW")

    def test_09_missing_proof_is_never_complete(self):
        self.assertEqual(self.a("", CAND, deps((V_PREV, 100)), TAGS, rel(PREV)), "UNVERIFIED")       # previous unknown
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), TAGS, None), "UNVERIFIED")          # readback down
        self.assertEqual(self.a(PREV, CAND, deps(), TAGS, rel(PREV)), "INCOMPLETE")                   # nothing active

    def test_10_cli_exit_and_annotations(self):
        def run(dep, release, code, health, pre):
            d = Path(tempfile.mkdtemp())
            for n, v in (("d.json", dep), ("t.json", TAGS), ("r.json", release), ("h.json", health)):
                (d / n).write_text("" if v is None else json.dumps(v))
            return subprocess.run([sys.executable, str(ROOT / "scripts/deploy/verify-rollback-state.py"), PREV, CAND,
                                   str(d / "d.json"), str(d / "t.json"), str(d / "r.json"), code, str(d / "h.json"), pre],
                                  capture_output=True, text=True)
        r = run(deps((V_PREV, 100)), rel(PREV), "503", NEON_DOWN, "DEGRADED_PREEXISTING")
        self.assertEqual(r.returncode, 0)
        self.assertIn("ROLLBACK_STATE=COMPLETE", r.stdout)
        self.assertIn("HEALTH_STATE=DEGRADED_PREEXISTING", r.stdout)
        self.assertIn("::warning title=HEALTH_STATE::", r.stdout)
        r = run(None, rel(PREV), "503", NEON_DOWN, "DEGRADED_PREEXISTING")
        self.assertEqual(r.returncode, 2)
        self.assertIn("::error title=ROLLBACK_STATE::UNVERIFIED", r.stdout)


class WorkflowContract(unittest.TestCase):
    src = (ROOT / ".github/workflows/central-production-deploy.yml").read_text(encoding="utf-8")

    def step(self, name):
        i = self.src.index(f"      - name: {name}\n")
        j = self.src.find("\n      - name: ", i + 10)
        return self.src[i:j]

    def test_predeploy_state_recorded_before_promotion_read_only(self):
        rec = self.step("Record pre-deploy production state (read-only)")
        self.assertLess(self.src.index(rec), self.src.index("      - name: Deploy repaired production worker\n"))
        self.assertNotRegex(rec, r"wrangler|-X (POST|PUT|PATCH|DELETE)|gh workflow run")
        self.assertIn('PREVIOUS_RUNTIME_SHA=$prev" >> "$GITHUB_ENV"', rec)
        self.assertIn('PREDEPLOY_HEALTH=$state" >> "$GITHUB_ENV"', rec)

    def test_classification_cannot_turn_failure_into_success_or_renew_proof(self):
        rb = self.step("Automatic rollback after failed post-deploy smoke")
        fail = rb.index('echo "AUTO_ROLLBACK_HEALTH=FAIL"')
        tail = rb[fail:]
        self.assertIn("verify-rollback-state.py", tail)
        self.assertNotIn("exit 0", tail)
        self.assertNotIn("gh workflow run", tail)
        self.assertTrue(tail.rstrip().endswith("exit 1"))
        self.assertRegex(tail, r'verify-rollback-state\.py[^\n]*\|\| true\n\s+exit 1')
        self.assertNotRegex(tail, r"-X (POST|PUT|PATCH|DELETE)|wrangler")
        # renewal: still exactly once, still only in the verified-health branch, before the FAIL line
        self.assertEqual(rb.count("gh workflow run order12a-financial-proof-renewal.yml"), 1)
        self.assertLess(rb.index('echo "AUTO_ROLLBACK_HEALTH=PASS"'), rb.index("gh workflow run order12a-financial-proof-renewal.yml"))
        self.assertLess(rb.index("gh workflow run order12a-financial-proof-renewal.yml"), fail)
        self.assertNotIn("verify-rollback-state.py", rb[:fail])


if __name__ == "__main__":
    unittest.main(verbosity=2)
