"""Live meta-tests for scripts/ci/mutant_classifier.py: real `node --test` runs of the probe suite.

Runs on the Node version on PATH (CI matrix: Node 22 and 24, Linux and Windows). Every case spawns node on
tests/fixtures/mutant_classifier/probe.mjs copied into a temporary directory, so the captured TAP does not embed the
checkout path. With MUTANT_CLASSIFIER_CAPTURE_DIR set, each case's stdout is written there byte-exact as <case>.tap
(this is how tests/fixtures/mutant_classifier/node22 and node24 were captured).
Run: python -m unittest tests.test_mutant_classifier_live -v
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import mutant_classifier as mc  # noqa: E402

PROBE = ROOT / "tests" / "fixtures" / "mutant_classifier" / "probe.mjs"
BASELINE = 6
TAP = ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout"]
E_T1 = {"primary": [{"test_pattern": "T1", "assertion_pattern": "A1"}]}
E_T2 = {"primary": [{"test_pattern": "T2", "assertion_pattern": "A2a"}]}
AL_T3 = [{"id": "AL_probe_T3_duplicate_key", "test_pattern": "T3", "regex": r"Command failed: psql duplicate key",
          "why": "probe: the error mode makes T3 throw this exact psql error"}]
NODE = shutil.which("node")


class LiveNode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE:
            raise RuntimeError("node is required for the live meta-tests")
        cls.tmp = Path(tempfile.mkdtemp(prefix="mc-live-"))
        shutil.copy(PROBE, cls.tmp / "probe.mjs")
        (cls.tmp / "syntax.mjs").write_text("import test from 'node:test';\nconst = ;\n", encoding="utf-8")
        (cls.tmp / "missing.mjs").write_text("import test from 'node:test';\nimport x from './nope-missing.mjs';\n"
                                             "test('T1 alpha', () => {});\n", encoding="utf-8")
        # the test file's own process dies by SIGTERM: node reports a REAL top-level `signal: 'SIGTERM'` (POSIX)
        (cls.tmp / "sigterm.mjs").write_text("import test from 'node:test';\ntest('T1 alpha', async () => {\n"
                                             "  process.kill(process.pid, 'SIGTERM');\n"
                                             "  await new Promise((r) => setTimeout(r, 5000));\n});\n", encoding="utf-8")
        cls.capture = os.environ.get("MUTANT_CLASSIFIER_CAPTURE_DIR")
        if cls.capture:
            Path(cls.capture).mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_probe(self, case, mode="", file="probe.mjs", timeout=120):
        env = {**os.environ, "PROBE_MODE": mode}
        env.pop("NODE_OPTIONS", None)
        run = mc.run_command([NODE, *TAP, file], cwd=self.tmp, timeout=timeout, env=env)
        if self.capture:
            Path(self.capture, f"{case}.tap").write_bytes(run["stdout"].encode("utf-8"))
        return run

    def verdict(self, case, mode, expected=E_T1, allowlist=(), file="probe.mjs"):
        run = self.run_probe(case, mode, file)
        return mc.classify_run(BASELINE, run, expected, allowlist, mutant_id=case)

    def test_01_clean_survived(self):
        r = self.verdict("clean", "")
        self.assertEqual(r["verdict"], mc.SURVIVED, r)
        self.assertTrue(mc.validate_baseline(BASELINE, 0, mc.parse_tap(self.run_probe("baseline")["stdout"])["summary"])["ok"])

    def test_02_kill(self):
        r = self.verdict("kill", "kill")
        self.assertEqual((r["verdict"], r["killing_tests"]), (mc.KILLED, ["T1 alpha"]), r)

    def test_03_kill_nested(self):
        r = self.verdict("kill_nested", "kill_nested", E_T2)
        self.assertEqual((r["verdict"], r["killing_tests"]), (mc.KILLED, ["T2 gamma > T2a nested"]), r)

    def test_04_label_on_ok_line_plus_unrelated(self):
        r = self.verdict("label_ok_extra", "label_ok,extra")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertTrue(r["reason"].startswith("label_outside_block"), r)

    def test_05_expected_plus_unexpected(self):
        r = self.verdict("kill_extra", "kill,extra")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertTrue(r["reason"].startswith("unexpected_failure"), r)

    def test_06_prefix_collision(self):
        r = self.verdict("collide", "collide")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertEqual(r["killing_tests"], [], r)

    def test_07_type_error(self):
        r = self.verdict("type", "type")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertIn("type_error", r["reason"], r)

    def test_08_syntax_error(self):
        r = self.verdict("syntax", "", file="syntax.mjs")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertTrue(r["reason"].startswith("infra:"), r)

    def test_09_missing_module(self):
        r = self.verdict("missing_module", "", file="missing.mjs")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertIn("missing_module", r["reason"], r)

    def test_10_skip_todo_slow(self):
        for case in ("skip", "todo", "slow"):
            r = self.verdict(case, f"kill,{case}")
            self.assertEqual(r["verdict"], mc.INCONCLUSIVE, (case, r))
            self.assertTrue(r["reason"].startswith("unexpected_skip_todo_cancelled"), (case, r))

    def test_11_allowlisted_error_still_killed(self):
        r = self.verdict("kill_error", "kill,error", allowlist=AL_T3)
        self.assertEqual((r["verdict"], r["allowlist_used"]), (mc.KILLED, ["AL_probe_T3_duplicate_key"]), r)
        r = self.verdict("kill_error", "kill,error")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)

    def test_12_process_timeout(self):
        run = mc.run_command([NODE, *TAP, "probe.mjs"], cwd=self.tmp, timeout=4,
                             env={**os.environ, "PROBE_MODE": "kill,hang"})
        self.assertTrue(run["timed_out"])
        r = mc.classify_run(BASELINE, run, E_T1)
        self.assertEqual((r["verdict"], r["reason"]), (mc.INCONCLUSIVE, "timeout"), r)

    def test_13_killed_process(self):
        p = subprocess.Popen([NODE, *TAP, "probe.mjs"], cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             stdin=subprocess.DEVNULL, env={**os.environ, "PROBE_MODE": "kill,hang"})
        time.sleep(1.5)
        p.kill()
        out, err = p.communicate(timeout=30)
        sig = None
        if p.returncode < 0:
            sig = f"SIG{-p.returncode}"
        run = {"return_code": p.returncode, "stdout": out.decode("utf-8", "replace"),
               "stderr": err.decode("utf-8", "replace"), "timed_out": False, "signal": sig}
        r = mc.classify_run(BASELINE, run, E_T1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        if os.name == "posix":
            self.assertTrue(r["reason"].startswith("signal:"), r)

    def test_14_missing_tool(self):
        run = mc.run_command(["definitely-not-a-real-tool-mc"], cwd=self.tmp, timeout=10)
        r = mc.classify_run(BASELINE, run, E_T1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertIn("missing_tool", r["reason"], r)

    def test_15_field_lines_in_dumped_source_stay_killed(self):
        # signal:/code:/failureType:/error:/exitCode: lines inside `actual: |-`, `expected: |-` and nested
        # `actual:` mappings are data, not the failure's fields: the primary assertion still kills (#898 M09/M16/M20).
        for case in ("source", "source_eq", "deep"):
            r = self.verdict(case, case)
            self.assertEqual((r["verdict"], r["killing_tests"], r["assertion_ids"]), (mc.KILLED, ["T1 alpha"], ["A1"]),
                             (case, r))

    def test_16_real_top_level_signal_inconclusive(self):
        run = self.run_probe("sigterm", "", file="sigterm.mjs")
        r = mc.classify_run(1, run, E_T1, mutant_id="sigterm")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertTrue(r["reason"].startswith("infra_failure:"), r)
        if os.name == "posix":
            self.assertEqual(r["reason"], "infra_failure:signal:sigterm.mjs", r)


if __name__ == "__main__":
    unittest.main()
