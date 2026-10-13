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
    def test_effective_must_be_candidate(self):
        self.assertTrue(pg.verify_effective(C, C, C)[0])
        self.assertTrue(pg.verify_effective(C, C, None)[0])
        self.assertFalse(pg.verify_effective(C, B, C)[0])
        self.assertFalse(pg.verify_effective(C, C, B)[0])
        self.assertFalse(pg.verify_effective(C, None, None)[0])


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
