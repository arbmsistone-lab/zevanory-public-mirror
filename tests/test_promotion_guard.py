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
    def d(self, cand, tip=C, http=None, cf=None, rb=False):
        return pg.decide(cand, tip, http, cf, ancestor, rb)

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

    def test_unreadable_production_only_allows_branch_tip(self):
        self.assertEqual(self.d(C, tip=C)[0], "promote")
        self.assertEqual(self.d(B, tip=C)[0], "refuse")

    def test_rollback_needs_explicit_authorisation(self):
        self.assertEqual(self.d(A, http=C, rb=False)[0], "skip-superseded")
        self.assertEqual(self.d(A, http=C, rb=True)[0], "promote-rollback")

    def test_cloudflare_tag_alone_is_enough(self):
        self.assertEqual(self.d(C, cf=B)[0], "promote")

    def test_invalid_candidate_refuses(self):
        self.assertEqual(self.d("main")[0], "refuse")


class Readers(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
