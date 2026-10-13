"""T1 (#804): fail-closed replay decision for the production publisher.

Uses two REAL GitHub run snapshots (public metadata only) plus synthetic variations:
  * 38461830758 attempt 1: published, smoke failed, rollback ran -> must refuse;
  * 38459418578 attempt 1: failed at the binding budget, publish skipped -> may replay.
"""
import copy
import importlib.util
import json
import pathlib
import unittest
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("auto_rerun_decision", ROOT / "scripts/deploy/auto_rerun_decision.py")
ard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ard)
FIX = ROOT / "tests/fixtures/auto_rerun"
load = lambda n: json.loads((FIX / f"{n}.json").read_text())
POST_PUBLISH = (load("run-38461830758-a1"), load("jobs-38461830758-a1"))
PRE_PUBLISH = (load("run-38459418578"), load("jobs-38459418578"))


def deploy_steps(jobs):
    return next(j for j in jobs["jobs"] if j["name"] == "deploy")["steps"]


class Decide(unittest.TestCase):
    def test_real_post_publish_failure_with_rollback_is_refused(self):
        self.assertEqual(ard.decide(*POST_PUBLISH)[0], "refuse")

    def test_real_pre_publish_failure_is_replayable(self):
        self.assertEqual(ard.decide(*PRE_PUBLISH), ("pre_publish", "failed_before_publish_step"))

    def mutate(self, fn):
        run, jobs = copy.deepcopy(PRE_PUBLISH)
        fn(run, jobs)
        return ard.decide(run, jobs)

    def test_publish_started_or_any_state_but_skipped_is_refused(self):
        for state in ("success", "failure", "cancelled", None, "in_progress"):
            def f(run, jobs, state=state):
                next(s for s in deploy_steps(jobs) if s["name"] == ard.PUBLISH)["conclusion"] = state
            self.assertEqual(self.mutate(f)[0], "refuse", state)

    def test_rollback_ran_is_refused(self):
        def f(run, jobs):
            next(s for s in deploy_steps(jobs) if s["name"].startswith(ard.ROLLBACK_PREFIX))["conclusion"] = "success"
        self.assertEqual(self.mutate(f)[0], "refuse")

    def test_missing_or_duplicated_steps_are_not_proven(self):
        def no_publish(run, jobs):
            next(j for j in jobs["jobs"] if j["name"] == "deploy")["steps"] = [s for s in deploy_steps(jobs) if s["name"] != ard.PUBLISH]
        def no_rollback(run, jobs):
            next(j for j in jobs["jobs"] if j["name"] == "deploy")["steps"] = [s for s in deploy_steps(jobs) if not s["name"].startswith(ard.ROLLBACK_PREFIX)]
        def no_steps(run, jobs):
            next(j for j in jobs["jobs"] if j["name"] == "deploy")["steps"] = []
        def dup_publish(run, jobs):
            st = deploy_steps(jobs); st.append(dict(next(s for s in st if s["name"] == ard.PUBLISH)))
        for fn in (no_publish, no_rollback, no_steps, dup_publish):
            verdict, why = self.mutate(fn)
            self.assertEqual(verdict, "refuse", fn.__name__); self.assertIn("not_proven", why)

    def test_unknown_step_state_before_publish_is_not_proven(self):
        def f(run, jobs):
            deploy_steps(jobs)[2]["conclusion"] = "neutral"
        self.assertEqual(self.mutate(f), ("refuse", "not_proven:unknown_step_state_before_publish"))

    def test_incomplete_listing_unexpected_jobs_and_run_state_are_not_proven(self):
        cases = {
            "total_count": lambda r, j: j.__setitem__("total_count", 3),
            "extra_job": lambda r, j: j["jobs"].append({"name": "x", "status": "completed", "conclusion": "success", "steps": []}) or j.__setitem__("total_count", 3),
            "attempt2": lambda r, j: r.__setitem__("run_attempt", 2),
            "in_progress": lambda r, j: r.__setitem__("status", "in_progress"),
            "cancelled": lambda r, j: r.__setitem__("conclusion", "cancelled"),
            "job_running": lambda r, j: j["jobs"][0].__setitem__("status", "in_progress"),
        }
        for name, fn in cases.items():
            self.assertEqual(self.mutate(fn)[0], "refuse", name)
        self.assertEqual(ard.decide(None, PRE_PUBLISH[1])[0], "refuse")
        self.assertEqual(ard.decide(PRE_PUBLISH[0], {"jobs": "x"})[0], "refuse")

    def test_guard_failure_with_deploy_never_started_is_replayable(self):
        def f(run, jobs):
            for j in jobs["jobs"]:
                if j["name"] == "guard": j["conclusion"] = "failure"
                if j["name"] == "deploy": j["conclusion"] = "skipped"; j["steps"] = []
        self.assertEqual(self.mutate(f), ("pre_publish", "guard_failed_deploy_never_started"))


class Main(unittest.TestCase):
    def run_main(self, responses):
        import os
        os.environ.update(GITHUB_REPOSITORY="o/r", RUN_ID="1", GH_TOKEN="t")
        calls, lines = [], []
        seq = iter(responses)

        def fetch(url):
            calls.append(url)
            item = next(seq)
            if isinstance(item, Exception):
                raise item
            return copy.deepcopy(item)
        code = ard.main(fetch=fetch, sleep=lambda s: None, out=lines.append)
        return code, lines, calls

    def test_api_unavailable_never_replays(self):
        code, lines, _ = self.run_main([urllib.error.URLError("down")])
        self.assertEqual(code, 0); self.assertIn("AUTO_RERUN_REFUSED", lines[0]); self.assertIn("api_error", lines[0])
        code, _, _ = self.run_main([PRE_PUBLISH[0], urllib.error.HTTPError("u", 502, "bad", {}, None)])
        self.assertEqual(code, 0)

    def test_replay_only_after_identical_revalidation(self):
        code, lines, calls = self.run_main([*PRE_PUBLISH, *PRE_PUBLISH])
        self.assertEqual(code, 10); self.assertEqual(lines[-1], "DECISION=replay:failed_before_publish_step"); self.assertEqual(len(calls), 4)

    def test_state_change_between_checks_blocks_replay(self):
        later_run = dict(PRE_PUBLISH[0], run_attempt=2)  # someone/something re-ran it meanwhile
        code, lines, _ = self.run_main([*PRE_PUBLISH, later_run, PRE_PUBLISH[1]])
        self.assertEqual(code, 0); self.assertIn("revalidation", lines[-1])
        other_sha = dict(PRE_PUBLISH[0], head_sha="f" * 40)
        code, lines, _ = self.run_main([*PRE_PUBLISH, other_sha, PRE_PUBLISH[1]])
        self.assertEqual(code, 0)
        code, lines, _ = self.run_main([*PRE_PUBLISH, urllib.error.URLError("down")])
        self.assertEqual(code, 0, "API failure during revalidation: no replay")

    def test_post_publish_refused_without_second_lookup(self):
        code, lines, calls = self.run_main([*POST_PUBLISH])
        self.assertEqual(code, 0); self.assertEqual(len(calls), 2); self.assertIn("publish_or_rollback_ran", lines[0])


if __name__ == "__main__":
    unittest.main()
