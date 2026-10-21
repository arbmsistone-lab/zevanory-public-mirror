"""Unit tests for scripts/deploy/promotion_guard.py (plan 3.1, T1)."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "promotion_guard", pathlib.Path(__file__).resolve().parents[1] / "scripts" / "deploy" / "promotion_guard.py")
pg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pg)

A = "a" * 40  # oldest
B = "b" * 40  # child of A
C = "c" * 40  # child of B (tip)
X = "e" * 40  # diverged branch
ORDER = [A, B, C]


def ancestor(older, newer):
    if older == newer:
        return True
    if older in ORDER and newer in ORDER:
        return ORDER.index(older) < ORDER.index(newer)
    return False


class Decide(unittest.TestCase):
    def d(self, cand, http=None, cf=None):
        return pg.decide(cand, http, cf, ancestor)

    def test_forward_promotes(self):
        self.assertEqual(self.d(C, http=B, cf=B)[0], "promote")

    def test_same_sha_redeploys(self):
        self.assertEqual(self.d(B, http=B)[0], "promote")

    def test_older_queued_run_is_skipped_not_deployed(self):
        decision, live, reason = self.d(A, http=C, cf=C)
        self.assertEqual((decision, reason), ("skip-superseded", "candidate_older_than_live"))

    def test_diverged_history_refuses(self):
        self.assertEqual(self.d(X, http=B)[0], "refuse")

    def test_effective_deployment_mismatch_refuses(self):
        decision, _, reason = self.d(C, http=B, cf=A)
        self.assertEqual(decision, "refuse")
        self.assertTrue(reason.startswith("effective_deployment_mismatch"))

    def test_unknown_production_always_refuses_even_for_branch_tip(self):
        # Audit 13/10 (P0): unknown effective version is never permission to publish.
        for cand in (A, B, C):
            self.assertEqual(self.d(cand), ("refuse", None, "production_version_unknown"))

    def test_never_moves_backwards(self):
        # No rollback path in the guard: a deliberate rollback is a reviewed git revert (forward).
        self.assertEqual(self.d(A, http=C)[0], "skip-superseded")
        self.assertNotIn("rollback", " ".join(pg.decide.__code__.co_varnames))

    def test_cloudflare_tag_alone_is_enough(self):
        self.assertEqual(self.d(C, cf=B)[0], "promote")

    def test_invalid_candidate_refuses(self):
        self.assertEqual(self.d("main")[0], "refuse")


class VerifyPromoted(unittest.TestCase):
    """Post-promotion: PASS requires BOTH sources present, equal to each other and to the candidate."""

    def test_both_sources_equal_candidate_passes(self):
        self.assertEqual(pg.verify_effective(C, C, C), (True, "PASS:effective_version_is_candidate"))

    def test_missing_cloudflare_source_is_not_proven(self):
        ok, reason = pg.verify_effective(C, C, None)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("NAO_COMPROVADO:cloudflare"), reason)

    def test_missing_readback_source_is_not_proven(self):
        ok, reason = pg.verify_effective(C, None, C)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("NAO_COMPROVADO:readback"), reason)

    def test_both_sources_missing_is_not_proven(self):
        ok, reason = pg.verify_effective(C, None, None)
        self.assertFalse(ok)
        self.assertEqual(reason, "NAO_COMPROVADO:cloudflare_and_readback_source_unreachable")

    def test_unparseable_source_counts_as_missing(self):
        self.assertTrue(pg.verify_effective(C, C, "not-a-sha")[1].startswith("NAO_COMPROVADO:"))

    def test_sources_disagree_fails(self):
        ok, reason = pg.verify_effective(C, B, C)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("FAIL:sources_disagree"), reason)
        self.assertTrue(pg.verify_effective(C, C, B)[1].startswith("FAIL:sources_disagree"))

    def test_both_agree_on_other_version_fails(self):
        ok, reason = pg.verify_effective(C, B, B)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("FAIL:cloudflare_reports_"), reason)

    def test_one_source_wrong_other_missing_fails_not_unproven(self):
        self.assertTrue(pg.verify_effective(C, B, None)[1].startswith("FAIL:readback_reports_"))
        self.assertTrue(pg.verify_effective(C, None, B)[1].startswith("FAIL:cloudflare_reports_"))

    def test_source_that_answered_without_sha_is_failure_not_unproven(self):
        ok, reason = pg.verify_effective(C, ("answered", None), ("ok", C))
        self.assertEqual((ok, reason), (False, "FAIL:readback_answered_without_candidate_sha"))
        self.assertTrue(pg.verify_effective(C, ("ok", C), ("answered", None))[1].startswith("FAIL:cloudflare_answered"))

    def test_unreachable_observer_is_unproven_not_failure(self):
        ok, reason = pg.verify_effective(C, ("ok", C), ("unreachable", None))
        self.assertEqual((ok, reason), (False, "NAO_COMPROVADO:cloudflare_source_unreachable"))

    def _run(self, http, cf, unproven_exit=2, sequence=None):
        import argparse
        import contextlib
        import io
        import os
        import tempfile
        args = argparse.Namespace(service="svc", candidate=C, readback_url="https://x", readback_path="sha",
                                  cloudflare_script="svc", attempts=4, interval=0, unproven_exit=unproven_exit)
        saved = (pg.observe_readback, pg.observe_cloudflare)
        calls = {"n": 0}

        def obs(value):
            if isinstance(value, tuple):
                return value
            return ("ok", value) if value else ("unreachable", None)

        def http_obs(*a, **k):
            calls["n"] += 1
            if sequence:
                return obs(sequence[min(calls["n"], len(sequence)) - 1])
            return obs(http)
        pg.observe_readback, pg.observe_cloudflare = http_obs, (lambda *a, **k: obs(cf))
        out = io.StringIO()
        gh_out = tempfile.NamedTemporaryFile("w+", delete=False)
        os.environ["GITHUB_OUTPUT"] = gh_out.name
        try:
            with contextlib.redirect_stdout(out):
                code = pg.verify_promoted(args)
        finally:
            pg.observe_readback, pg.observe_cloudflare = saved
            del os.environ["GITHUB_OUTPUT"]
        return code, out.getvalue(), open(gh_out.name).read()

    def test_verify_promoted_exit_codes(self):
        self.assertEqual(self._run(C, C)[0], 0)
        code, out, gh = self._run(C, None)
        self.assertEqual(code, 2, "missing Cloudflare source fails the step by default (NAO_COMPROVADO)")
        self.assertIn('"state": "NAO_COMPROVADO"', out)
        self.assertIn("state=NAO_COMPROVADO", gh)
        self.assertEqual(self._run(None, C)[0], 2, "unreachable readback fails the step by default (NAO_COMPROVADO)")
        code, out, gh = self._run(B, C)
        self.assertEqual(code, 1)
        self.assertIn('"state": "FAIL"', out)
        self.assertIn("state=FAIL", gh)

    def test_unproven_can_be_deferred_but_fail_never_is(self):
        # Workflows with automatic rollback: NAO_COMPROVADO must not fail the verify step
        # (rollback is gated on failure()); a later gate fails the run instead.
        code, _, gh = self._run(C, None, unproven_exit=0)
        self.assertEqual(code, 0)
        self.assertIn("state=NAO_COMPROVADO", gh)
        self.assertEqual(self._run(B, C, unproven_exit=0)[0], 1, "positive evidence always fails -> recovery runs")
        self.assertEqual(self._run(("answered", None), C, unproven_exit=0)[0], 1)

    def test_propagation_delay_then_pass(self):
        code, out, _ = self._run(None, C, sequence=[B, B, C])
        self.assertEqual(code, 0, "old SHA during edge propagation must not fail if the candidate appears within the window")


class Readers(unittest.TestCase):
    def test_cloudflare_token_surrounding_whitespace(self):
        import http.client
        import os
        from unittest.mock import patch

        for token in ("synthetic-token", "synthetic-token\n", "synthetic-token\r\n",
                      " \tsynthetic-token \t"):
            with self.subTest(token=token), patch.dict(os.environ, {
                "CLOUDFLARE_API_TOKEN": token, "CLOUDFLARE_ACCOUNT_ID": "acc",
            }, clear=True):
                requests = []

                def fetch(url, headers=None):
                    requests.append((url, headers))
                    # Exercise Python's real header validation without opening a connection.
                    conn = http.client.HTTPSConnection("example.invalid")
                    conn.putrequest("GET", "/")
                    conn.putheader("Authorization", headers["Authorization"])
                    if url.endswith("/deployments"):
                        return {"success": True, "result": {"deployments": [
                            {"versions": [{"version_id": "v1", "percentage": 100}]}]}}
                    return {"success": True, "result": {"metadata": {"annotations": {"workers/tag": C}}}}

                self.assertEqual(pg.observe_cloudflare("zevanory", fetch), (pg.OK, C))
                base = "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/zevanory"
                self.assertEqual(requests, [
                    (base + "/deployments", {"Authorization": "Bearer " + "synthetic-token"}),
                    (base + "/versions/v1", {"Authorization": "Bearer " + "synthetic-token"}),
                ])

    def test_cloudflare_whitespace_only_token_does_not_fetch(self):
        import os
        from unittest.mock import Mock, patch

        with patch.dict(os.environ, {
            "CLOUDFLARE_API_TOKEN": " \t\r\n", "CLOUDFLARE_ACCOUNT_ID": "acc",
        }, clear=True):
            fetch = Mock()
            self.assertEqual(pg.observe_cloudflare("zevanory", fetch), (pg.UNREACHABLE, None))
            fetch.assert_not_called()

    def test_readback_path(self):
        fetch = lambda url, headers=None: {"deployment": {"commit_sha": B.upper()}}
        self.assertEqual(pg.readback_sha("https://x", "deployment.commit_sha", fetch), B)
        self.assertIsNone(pg.readback_sha("https://x", "missing.path", fetch))

    def test_cloudflare_single_full_version_tag(self):
        import os
        os.environ["CLOUDFLARE_API_TOKEN"] = "t"
        os.environ["CLOUDFLARE_ACCOUNT_ID"] = "acc"

        def fetch(url, headers=None):
            if url.endswith("/deployments"):
                return {"result": {"deployments": [{"versions": [{"version_id": "v1", "percentage": 100}]}]}}
            return {"result": {"metadata": {"annotations": {"workers/tag": C}}}}
        self.assertEqual(pg.cloudflare_sha("zevanory", fetch), C)

        def split(url, headers=None):
            return {"result": {"deployments": [{"versions": [{"version_id": "v1", "percentage": 50}, {"version_id": "v2", "percentage": 50}]}]}}
        self.assertIsNone(pg.cloudflare_sha("zevanory", split), "gradual rollout is not a single effective version")
        self.assertEqual(pg.observe_cloudflare("zevanory", split), ("answered", None))

        def untagged(url, headers=None):
            if url.endswith("/deployments"):
                return {"result": {"deployments": [{"versions": [{"version_id": "v1", "percentage": 100}]}]}}
            return {"result": {"metadata": {"annotations": {}}}}
        self.assertEqual(pg.observe_cloudflare("zevanory", untagged), ("answered", None), "active version without tag")

        def api_down(url, headers=None):
            raise OSError("cloudflare api timeout")
        self.assertEqual(pg.observe_cloudflare("zevanory", api_down), ("unreachable", None))
        self.assertEqual(pg.observe_cloudflare("zevanory", lambda u, h=None: {"success": False}), ("unreachable", None))
        del os.environ["CLOUDFLARE_API_TOKEN"]
        self.assertEqual(pg.observe_cloudflare("zevanory", fetch), ("unreachable", None), "no credential = observer failed")

    def test_readback_observation(self):
        import urllib.error
        def http_500(url, headers=None):
            raise urllib.error.HTTPError(url, 503, "down", {}, None)
        self.assertEqual(pg.observe_readback("https://x", "sha", http_500), ("answered", None), "service answered with error")
        def timeout(url, headers=None):
            raise TimeoutError()
        self.assertEqual(pg.observe_readback("https://x", "sha", timeout), ("unreachable", None))
        self.assertEqual(pg.observe_readback("https://x", "sha", lambda u, h=None: {"sha": None}), ("answered", None))


if __name__ == "__main__":
    unittest.main()
