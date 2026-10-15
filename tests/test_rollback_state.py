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
            self.assertEqual(vrs.rollback_state(PREV, CAND, broken, TAGS, rel(PREV)), ("UNVERIFIED", "cloudflare_deployments_unreadable"))
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), {}, rel(PREV)), "UNVERIFIED")  # tag unreadable

    def test_06_split_traffic_is_incomplete(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 90), (V_CAND, 10)), TAGS, rel(PREV)), "INCOMPLETE")
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 99)), TAGS, rel(PREV)), "INCOMPLETE")

    def test_07_later_neon_recovery(self):
        self.assertEqual(self.a(PREV, CAND, deps((V_PREV, 100)), TAGS, rel(PREV)), "COMPLETE")
        self.assertEqual(vrs.health_state("200", HEALTHY, "DEGRADED_PREEXISTING"), "HEALTHY")

    def test_08_new_degradation_is_not_preexisting(self):
        self.assertEqual(vrs.health_state("503", NEON_DOWN, "HEALTHY"), "DEGRADED_NEW")
        self.assertEqual(vrs.health_state("200", {"live": True, "ready": False}, "HEALTHY"), "DEGRADED_NEW")
        # C-45 D3: without a proven baseline it is never "preexisting"
        for pre in ("UNKNOWN", "", "DEGRADED", "degraded_preexisting", None):
            self.assertEqual(vrs.health_state("503", NEON_DOWN, pre), "DEGRADED_UNKNOWN_BASELINE")

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


def one(vid=None, pct=100, created="2026-10-15T16:37:56.360629Z"):
    return {"result": {"deployments": [{"created_on": created, "versions": [{"version_id": vid or V_PREV, "percentage": pct}]}]}}


class C45Regressions(unittest.TestCase):
    """D1-D5 from the adversarial review C-2026-10-15-44."""

    def r(self, dep, tags=TAGS, release=None):
        return vrs.rollback_state(PREV, CAND, dep, tags, rel(PREV) if release is None else release)

    def test_d1_malformed_evidence_is_structured_unverified(self):
        cases = {
            "percentage_text": one(pct="abc"),
            "deployment_not_object": {"result": {"deployments": ["lixo"]}},
            "version_not_object": {"result": {"deployments": [{"created_on": "2026-10-15T16:37:56Z", "versions": ["v1"]}]}},
            "versions_not_list": {"result": {"deployments": [{"created_on": "2026-10-15T16:37:56Z", "versions": {"a": 1}}]}},
            "version_id_missing": {"result": {"deployments": [{"created_on": "2026-10-15T16:37:56Z", "versions": [{"percentage": 100}]}]}},
            "result_list": {"result": []},
            "html": "<html>502</html>",
            "tags_not_dict": None,
        }
        for name, dep in cases.items():
            with self.subTest(name):
                a, why = self.r(one() if name == "tags_not_dict" else dep, tags=["x"] if name == "tags_not_dict" else TAGS)
                self.assertEqual(a, "UNVERIFIED")
                self.assertTrue(why)
        # readback in an unexpected shape
        for bad in ([], {"deployment": []}, {"deployment": {"commit_sha": 123}}):
            self.assertEqual(self.r(one(), release=bad)[0], "UNVERIFIED")

    def test_d1_cli_never_tracebacks_and_prints_reason(self):
        d = Path(tempfile.mkdtemp())
        for n, v in (("d.json", one(pct="abc")), ("t.json", TAGS), ("r.json", rel(PREV)), ("h.json", NEON_DOWN)):
            (d / n).write_text(json.dumps(v))
        r = subprocess.run([sys.executable, str(ROOT / "scripts/deploy/verify-rollback-state.py"), PREV, CAND, str(d / "d.json"),
                            str(d / "t.json"), str(d / "r.json"), "503", str(d / "h.json"), "DEGRADED_PREEXISTING"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertNotIn("Traceback", r.stderr + r.stdout)
        self.assertIn("ROLLBACK_STATE=UNVERIFIED", r.stdout)
        self.assertRegex(r.stdout, r"ROLLBACK_REASON=\S+")

    def test_d2_exactly_100_no_coercion(self):
        for pct in (100.4, 100.9, 99.99999, 100 + 1e-9, 0, 101):  # numeric, not exactly 100
            with self.subTest(pct=pct):
                self.assertEqual(self.r(one(pct=pct))[0], "INCOMPLETE")
        for pct in ("100", True, float("nan"), float("inf"), None):  # not a number at all: no evidence
            with self.subTest(pct=pct):
                self.assertEqual(self.r(one(pct=pct)), ("UNVERIFIED", "cloudflare_percentage_invalid"))
        for pct in (100, 100.0):
            self.assertEqual(self.r(one(pct=pct))[0], "COMPLETE")

    def test_d5_active_deployment_needs_valid_unique_created_on(self):
        for created in (None, "", "ontem", "2026-10-15 16:37:56", "2026-10-15T16:37:56"):  # no timezone = not trustworthy
            with self.subTest(created=created):
                self.assertEqual(self.r(one(created=created))[0], "UNVERIFIED")
        tie = {"result": {"deployments": [
            {"created_on": "2026-10-15T16:37:56Z", "versions": [{"version_id": V_PREV, "percentage": 100}]},
            {"created_on": "2026-10-15T13:37:56-03:00", "versions": [{"version_id": V_CAND, "percentage": 100}]}]}}
        self.assertEqual(self.r(tie), ("UNVERIFIED", "active_deployment_ambiguous_same_created_on"))
        # order of the list does not matter; time zones and fractions are compared as instants
        later_cand = {"result": {"deployments": [
            {"created_on": "2026-10-15T16:37:56.1Z", "versions": [{"version_id": V_PREV, "percentage": 100}]},
            {"created_on": "2026-10-15T13:37:56.2-03:00", "versions": [{"version_id": V_CAND, "percentage": 100}]}]}}
        self.assertEqual(self.r(later_cand)[0], "INCOMPLETE")
        self.assertEqual(vrs.active_deployment(later_cand)[0]["version_id"], V_CAND)

    def test_d3_predeploy_baseline_requires_unambiguous_evidence(self):
        self.assertEqual(vrs.predeploy_state("200", HEALTHY), "HEALTHY")
        self.assertEqual(vrs.predeploy_state("503", NEON_DOWN), "DEGRADED_PREEXISTING")
        for code, body in (("000", None), ("", None), ("503", None), ("503", {}), ("503", {"ready": None}),
                           ("503", {"ready": "false"}), ("502", NEON_DOWN), ("500", NEON_DOWN), ("200", {"live": True, "ready": False}),
                           ("200", None), ("429", None)):
            with self.subTest(code=code, body=body):
                self.assertEqual(vrs.predeploy_state(code, body), "UNKNOWN")

    def test_d3_cli_predeploy_and_active_versions(self):
        d = Path(tempfile.mkdtemp())
        (d / "h.json").write_text("")
        out = subprocess.run([sys.executable, str(ROOT / "scripts/deploy/verify-rollback-state.py"), "--predeploy", "000", str(d / "h.json")],
                             capture_output=True, text=True)
        self.assertEqual((out.returncode, out.stdout.strip()), (0, "UNKNOWN"))
        (d / "d.json").write_text(json.dumps(deps((V_PREV, 100))))
        out = subprocess.run([sys.executable, str(ROOT / "scripts/deploy/verify-rollback-state.py"), "--active-versions", str(d / "d.json")],
                             capture_output=True, text=True)
        self.assertEqual((out.returncode, out.stdout.strip()), (0, V_PREV))
        (d / "d.json").write_text("garbage")
        out = subprocess.run([sys.executable, str(ROOT / "scripts/deploy/verify-rollback-state.py"), "--active-versions", str(d / "d.json")],
                             capture_output=True, text=True)
        self.assertEqual((out.returncode, out.stdout.strip(), out.stderr), (0, "", ""))

    def test_d1_unexpected_internal_error_is_unverified_not_success(self):
        # defence in depth: an error nobody anticipated still yields a structured, failing result
        from unittest import mock
        with mock.patch.object(vrs, "active_deployment", side_effect=KeyError("boom")):
            self.assertEqual(self.r(one()), ("UNVERIFIED", "malformed_evidence:KeyError"))
        d = Path(tempfile.mkdtemp())
        for n in ("d.json", "t.json", "r.json", "h.json"):
            (d / n).write_text("{}")
        with mock.patch.object(vrs, "health_state", side_effect=RuntimeError("boom")), \
             mock.patch("builtins.print") as out:
            code = vrs.main(["x", PREV, CAND, str(d / "d.json"), str(d / "t.json"), str(d / "r.json"), "503", str(d / "h.json"), "UNKNOWN"])
        printed = "\n".join(str(c.args[0]) for c in out.call_args_list)
        self.assertEqual(code, 2)
        self.assertIn("ROLLBACK_STATE=UNVERIFIED", printed)
        self.assertIn("ROLLBACK_REASON=classifier_error:RuntimeError", printed)
        self.assertIn("HEALTH_STATE=DEGRADED_UNKNOWN_BASELINE", printed)

    def test_no_invalid_input_ever_yields_complete(self):
        import itertools
        deps_bad = [None, {}, "x", [], {"result": None}, one(pct=99), one(pct="100"), one(created=None), one(vid=V_CAND), one(vid=V_OTHER),
                    {"result": {"deployments": [{"created_on": "2026-10-15T16:37:56Z", "versions": [{"version_id": V_PREV, "percentage": 50},
                                                                                                     {"version_id": V_PREV, "percentage": 50}]}]}}]
        tags_bad = [None, {}, [], {V_PREV: "short"}, {V_PREV: None}]
        rel_bad = [None, {}, [], rel(OTHER), rel(CAND), {"deployment": {"commit_sha": None}}]
        for dep, tg, rl in itertools.product(deps_bad + [one()], tags_bad + [TAGS], rel_bad + [rel(PREV)]):
            if dep is not deps_bad[0] and dep == one() and tg is TAGS and rl == rel(PREV):
                continue  # the single fully valid combination
            self.assertNotEqual(vrs.rollback_state(PREV, CAND, dep, tg, rl)[0], "COMPLETE", (dep, tg, rl))


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
        # C-45 D3: baseline decided by the classifier, anything unexpected collapses to UNKNOWN
        self.assertIn("verify-rollback-state.py --predeploy", rec)
        self.assertIn("*) state=UNKNOWN ;;", rec)
        self.assertNotIn("state=DEGRADED_PREEXISTING", rec)

    def test_new_queries_have_explicit_timeouts(self):  # C-45 D4
        rec = self.step("Record pre-deploy production state (read-only)")
        rb = self.step("Automatic rollback after failed post-deploy smoke")
        tail = rb[rb.index('echo "AUTO_ROLLBACK_HEALTH=FAIL"'):]
        for block in (rec, tail):
            for line in re.findall(r"curl [^\n]*", block):
                self.assertIn("--max-time 20", line)

    def test_active_versions_use_the_classifier_rule(self):  # C-45 D5: one selection rule, not two
        rb = self.step("Automatic rollback after failed post-deploy smoke")
        self.assertIn("verify-rollback-state.py --active-versions", rb)
        self.assertNotIn("max(", rb)

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
