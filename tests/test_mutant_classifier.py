"""Meta-tests for scripts/ci/mutant_classifier.py (offline; Linux and Windows).

Synthetic TAP built here covers each rule in isolation; the captured fixtures in tests/fixtures/mutant_classifier
(real `node --test` output from Node 22 and Node 24, each also stored with CRLF line endings) prove the verdict does
not depend on the Node version or the line endings. Provenance: tests/test_mutant_classifier_live.py with
MUTANT_CLASSIFIER_CAPTURE_DIR set, on Linux, Node v22.22.0 and Node v24.21.0 (official binary; the same version the CI
live job ran); the *.crlf.tap twins are the same bytes with LF -> CRLF. Run: python -m unittest tests.test_mutant_classifier -v
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import mutant_classifier as mc  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "mutant_classifier"
SCRIPT = ROOT / "scripts" / "ci" / "mutant_classifier.py"
E_T1 = [{"test_pattern": "T1", "assertion_pattern": "A1"}]


# ------------------------------------------------------------------ synthetic TAP builder
def ok(name, n, directive=None, indent=0):
    pad = " " * indent
    d = f" # {directive}" if directive else ""
    return f"{pad}# Subtest: {name}\n{pad}ok {n} - {name}{d}\n{pad}  ---\n{pad}  duration_ms: 1.0\n{pad}  type: 'test'\n{pad}  ...\n"


def notok(name, n, error="boom", err_name="AssertionError", code="ERR_ASSERTION", ftype="testCodeFailure",
          indent=0, extra=""):
    pad = " " * indent
    return (f"{pad}# Subtest: {name}\n{pad}not ok {n} - {name}\n{pad}  ---\n{pad}  duration_ms: 1.0\n{pad}  type: 'test'\n"
            f"{pad}  failureType: '{ftype}'\n{pad}  error: |-\n{pad}    {error}\n{pad}    \n{pad}  code: '{code}'\n"
            f"{pad}  name: '{err_name}'\n{extra}{pad}  ...\n")


def tap(points, tests, passed, fail, cancelled=0, skipped=0, todo=0, plan=None, prefix="#", pre=""):
    plan = len([p for p in points if not p.startswith(" ")]) if plan is None else plan
    body = "".join(points)
    s = "\n".join(f"{prefix} {k} {v}" for k, v in (("tests", tests), ("suites", 0), ("pass", passed), ("fail", fail),
                                                   ("cancelled", cancelled), ("skipped", skipped), ("todo", todo),
                                                   ("duration_ms", 5.5)))
    return f"TAP version 13\n{pre}{body}1..{plan}\n{s}\n"


def run(text, rc, expected=E_T1, baseline=3, **kw):
    p = mc.parse_tap(text)
    return mc.classify(baseline, rc, p["summary"], p["failures"], expected, **kw)


CLEAN = tap([ok("T1 alpha", 1), ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 3, 0)
KILL = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 2, 1)


class Rule01Killed(unittest.TestCase):
    def test_expected_assertion_in_expected_block(self):
        r = run(KILL, 1)
        self.assertEqual(r["verdict"], mc.KILLED, r)
        self.assertEqual(r["killing_tests"], ["T1 alpha"])
        self.assertEqual(r["assertion_ids"], ["A1"])
        self.assertEqual(r["counts"]["fail"], 1)

    def test_nested_failure_belongs_to_parent_block(self):
        t = tap([ok("T1 alpha", 1), notok("T2a sub", 1, "A2a nested", indent=4) + "    1..1\n"
                 + notok("T2 gamma", 2, "1 subtest failed", "Error", "ERR_TEST_FAILURE", "subtestsFailed"),
                 ok("T3 x", 3)], 4, 2, 2, plan=3)
        r = run(t, 1, [{"test_pattern": "T2", "assertion_pattern": "A2a"}], baseline=4)
        self.assertEqual((r["verdict"], r["killing_tests"]), (mc.KILLED, ["T2 gamma > T2a sub"]), r)

    def test_runner_supplied_assertion_id(self):
        p = mc.parse_tap(KILL)
        p["failures"][0]["assertion_id"] = "A1"
        p["failures"][0]["error"] = "no label in text"
        self.assertEqual(mc.classify(3, 1, p["summary"], p["failures"], E_T1)["verdict"], mc.KILLED)

    def test_allowlisted_causal_error_keeps_killed_and_is_cited(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2),
                 notok("T2 gamma", 3, "Command failed: psql duplicate key", "Error", "ERR_TEST_FAILURE")], 3, 1, 2)
        al = [{"id": "AL1", "test_pattern": "T2", "regex": "duplicate key", "why": "mutation removes ON CONFLICT"}]
        r = run(t, 1, allowlist=al)
        self.assertEqual((r["verdict"], r["allowlist_used"]), (mc.KILLED, ["AL1"]), r)
        self.assertEqual(run(t, 1)["verdict"], mc.INCONCLUSIVE)


class Rule02Survived(unittest.TestCase):
    def test_clean_suite(self):
        r = run(CLEAN, 0)
        self.assertEqual(r["verdict"], mc.SURVIVED, r)

    def test_baseline_validation(self):
        p = mc.parse_tap(CLEAN)
        self.assertTrue(mc.validate_baseline(3, 0, p["summary"], p["failures"])["ok"])
        self.assertFalse(mc.validate_baseline(4, 0, p["summary"], p["failures"])["ok"])
        p = mc.parse_tap(KILL)
        self.assertFalse(mc.validate_baseline(3, 1, p["summary"], p["failures"])["ok"])


class Rule03LabelOutsideBlock(unittest.TestCase):
    def test_label_on_ok_line_plus_unrelated_failure(self):
        t = tap([ok("T1 alpha [A1]", 1), ok("T10 beta", 2), notok("T2 gamma", 3, "A9 unrelated")], 3, 2, 1)
        r = run(t, 1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertTrue(r["reason"].startswith("label_outside_block:A1@ok"), r)

    def test_label_only_in_other_tests_block(self):
        t = tap([ok("T1 alpha", 1), ok("T10 beta", 2), notok("T2 gamma", 3, "A1 alpha value")], 3, 2, 1)
        r = run(t, 1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertTrue(r["reason"].startswith("label_outside_block:A1@other_block"), r)

    def test_expected_test_fails_with_another_label(self):
        t = tap([notok("T1 alpha", 1, "A7 other"), ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 2, 1)
        self.assertEqual(run(t, 1)["verdict"], mc.INCONCLUSIVE)


class Rule04ExtraUnexpectedFailure(unittest.TestCase):
    def test_expected_plus_unexpected_assertion(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2), notok("T2 gamma", 3, "A3 x")], 3, 1, 2)
        r = run(t, 1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertEqual(r["unexpected_failures"], ["assertion:T2 gamma"])

    def test_expected_plus_unexpected_plain_error(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2),
                 notok("T2 gamma", 3, "something broke", "Error", "ERR_TEST_FAILURE")], 3, 1, 2)
        self.assertEqual(run(t, 1)["verdict"], mc.INCONCLUSIVE)

    def test_both_expected_is_killed(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2), notok("T2 gamma", 3, "A3 x")], 3, 1, 2)
        exp = E_T1 + [{"test_pattern": "T2", "assertion_pattern": "A3"}]
        self.assertEqual(run(t, 1, exp)["verdict"], mc.KILLED)


class Rule05InfraAndProcess(unittest.TestCase):
    def test_syntax_error_diagnostic(self):
        pre = "# file:///w/x.test.mjs:1\n# const = ;\n#       ^\n# SyntaxError: Unexpected token '='\n# Node.js v22.22.0\n"
        t = tap([notok("x.test.mjs", 1, "test failed", "Error", "ERR_TEST_FAILURE", extra="  exitCode: 1\n  signal: ~\n")],
                1, 0, 1, pre=pre)
        r = run(t, 1, baseline=1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE)
        self.assertIn("syntax_error", r["reason"])

    def test_type_error_in_test(self):
        t = tap([notok("T1 alpha", 1, "Cannot read properties of null", "TypeError", "ERR_TEST_FAILURE"),
                 ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 2, 1)
        r = run(t, 1)
        self.assertEqual((r["verdict"], r["reason"]), (mc.INCONCLUSIVE, "infra_failure:type_error:T1 alpha"))

    def test_type_error_text_inside_assertion_message_is_not_infra(self):
        t = tap([notok("T1 alpha", 1, "A1 expected TypeError: to be thrown"), ok("T10 beta", 2), ok("T2 gamma", 3)],
                3, 2, 1)
        self.assertEqual(run(t, 1)["verdict"], mc.KILLED)

    def test_missing_module(self):
        pre = "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/nope.mjs' imported from /w/x.test.mjs\n"
        t = tap([notok("x.test.mjs", 1, "test failed", "Error", "ERR_TEST_FAILURE", extra="  exitCode: 1\n")],
                1, 0, 1, pre=pre)
        self.assertIn("missing_module", run(t, 1, baseline=1)["reason"])
        t2 = tap([notok("T1 alpha", 1, "Cannot find package 'pg' imported from /w", "Error", "ERR_MODULE_NOT_FOUND"),
                  ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 2, 1)
        self.assertIn("missing_module", run(t2, 1)["reason"])

    def test_missing_tool(self):
        r = mc.classify_run(3, mc.run_command(["definitely-not-a-real-tool-mc"], timeout=10), E_T1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE)
        self.assertIn("missing_tool", r["reason"])

    def test_timeout_even_with_expected_assertion(self):
        self.assertEqual(run(KILL, 1, timed_out=True)["reason"], "timeout")

    def test_killed_process(self):
        self.assertEqual(run(KILL, 1, signal="SIGKILL")["verdict"], mc.INCONCLUSIVE)
        self.assertEqual(run(KILL, -9)["verdict"], mc.INCONCLUSIVE)
        self.assertEqual(run(KILL, None)["verdict"], mc.INCONCLUSIVE)

    def test_file_level_process_exit(self):
        t = tap([notok("x.test.mjs", 1, "test failed", "Error", "ERR_TEST_FAILURE", extra="  exitCode: 7\n  signal: ~\n"),
                 ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 2, 1)
        self.assertIn("process_exit", run(t, 1)["reason"])

    def test_non_unique_anchor(self):
        self.assertEqual(run(KILL, 1, anchor_ok=False)["reason"], "anchor_not_unique")

    def test_test_level_timeout_and_hook(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2),
                 notok("T2 gamma", 3, "hook failed", "Error", "ERR_TEST_FAILURE", "hookFailed")], 3, 1, 2)
        self.assertIn("hook", run(t, 1)["reason"])

    def test_extra_infra_pattern_from_runner(self):
        t = KILL.replace("1..3", "# ECONNRESET while talking to the harness\n1..3")
        p = mc.parse_tap(t, extra_infra=[r"ECONNRESET"])
        self.assertEqual(mc.classify(3, 1, p["summary"], p["failures"], E_T1)["verdict"], mc.INCONCLUSIVE)


class Rule06TruncatedOrInconsistent(unittest.TestCase):
    def test_truncated_tap(self):
        for cut in (len(KILL) // 3, len(KILL) // 2, KILL.index("# tests"), KILL.index("# todo")):
            self.assertEqual(run(KILL[:cut], 1)["verdict"], mc.INCONCLUSIVE, cut)

    def test_unclosed_yaml_block(self):
        t = KILL[:KILL.index("  ...\n")]
        self.assertTrue(run(t, 1)["reason"].startswith("truncated_tap"))

    def test_empty_output(self):
        self.assertEqual(run("", 1)["verdict"], mc.INCONCLUSIVE)

    def test_total_differs_from_baseline(self):
        self.assertTrue(run(KILL, 1, baseline=4)["reason"].startswith("count_mismatch"))
        self.assertTrue(run(CLEAN, 0, baseline=2)["reason"].startswith("count_mismatch"))

    def test_summary_disagrees_with_points(self):
        bad = KILL.replace("# pass 2\n# fail 1", "# pass 3\n# fail 0")
        self.assertTrue(run(bad, 0)["reason"].startswith("count_inconsistent"))
        bad2 = KILL.replace("# tests 3", "# tests 4")
        self.assertEqual(run(bad2, 1, baseline=4)["verdict"], mc.INCONCLUSIVE)

    def test_plan_disagrees_with_points(self):
        self.assertTrue(run(KILL.replace("1..3", "1..4"), 1)["reason"].startswith("truncated_tap"))

    def test_rc_inconsistent_with_summary(self):
        self.assertTrue(run(KILL, 0)["reason"].startswith("rc_inconsistent"))
        self.assertTrue(run(CLEAN, 1)["reason"].startswith("rc_inconsistent"))
        self.assertTrue(run(KILL, 2)["reason"].startswith("rc_inconsistent"))

    def test_invalid_baseline_total(self):
        for b in (0, None, True, "3"):
            self.assertEqual(run(KILL, 1, baseline=b)["verdict"], mc.INCONCLUSIVE, b)


class Rule07SkipTodoCancelled(unittest.TestCase):
    def test_skip(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2, "SKIP"), ok("T2 gamma", 3)], 3, 1, 1, skipped=1)
        self.assertTrue(run(t, 1)["reason"].startswith("unexpected_skip_todo_cancelled"))

    def test_todo(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2, "TODO"), ok("T2 gamma", 3)], 3, 1, 1, todo=1)
        self.assertTrue(run(t, 1)["reason"].startswith("unexpected_skip_todo_cancelled"))

    def test_cancelled(self):
        t = tap([notok("T1 alpha", 1, "A1 alpha value"), ok("T10 beta", 2),
                 notok("T2 gamma", 3, "test timed out after 50ms", "Error", "ERR_TEST_FAILURE", "testTimeoutFailure")],
                3, 1, 1, cancelled=1)
        self.assertTrue(run(t, 1)["reason"].startswith("unexpected_skip_todo_cancelled"))

    def test_clean_with_skip_is_not_survived(self):
        t = tap([ok("T1 alpha", 1), ok("T10 beta", 2, "SKIP"), ok("T2 gamma", 3)], 3, 2, 0, skipped=1)
        self.assertEqual(run(t, 0)["verdict"], mc.INCONCLUSIVE)


class Rule08PrefixCollision(unittest.TestCase):
    def test_T1_does_not_match_T10(self):
        t = tap([ok("T1 alpha", 1), notok("T10 beta", 2, "A1 alpha value"), ok("T2 gamma", 3)], 3, 2, 1)
        r = run(t, 1)
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertEqual(r["killing_tests"], [])

    def test_A1_does_not_match_A10(self):
        t = tap([notok("T1 alpha", 1, "A10 other value"), ok("T10 beta", 2), ok("T2 gamma", 3)], 3, 2, 1)
        self.assertEqual(run(t, 1)["verdict"], mc.INCONCLUSIVE)

    def test_matcher_boundaries(self):
        m = mc._test_matches
        self.assertTrue(m("T1", "T1 alpha") and m("T1", "T1") and m("S2 ", "S2 x") and m("kill-switch:", "kill-switch: y"))
        self.assertFalse(m("T1", "T10 beta") or m("T1", "T1a") or m("S2 ", "S20 x") or m("T1", "XT1"))
        self.assertTrue(m("re:T1[0-9]", "T10 beta"))
        self.assertTrue(mc._label_in("A1", "fails A1: x") and not mc._label_in("A1", "A10") and not mc._label_in("A1", "BA1"))


CASES = {  # case -> (return code, expected entries, allowlist, verdict, reason prefix)
    "clean": (0, E_T1, [], mc.SURVIVED, "suite_passed"),
    "baseline": (0, E_T1, [], mc.SURVIVED, "suite_passed"),
    "kill": (1, E_T1, [], mc.KILLED, "expected_assertion"),
    "kill_nested": (1, [{"test_pattern": "T2", "assertion_pattern": "A2a"}], [], mc.KILLED, "expected_assertion"),
    "label_ok_extra": (1, E_T1, [], mc.INCONCLUSIVE, "label_outside_block"),
    "kill_extra": (1, E_T1, [], mc.INCONCLUSIVE, "unexpected_failure"),
    "collide": (1, E_T1, [], mc.INCONCLUSIVE, "label_outside_block"),
    "type": (1, E_T1, [], mc.INCONCLUSIVE, "infra_failure:type_error"),
    "syntax": (1, E_T1, [], mc.INCONCLUSIVE, "infra:"),
    "missing_module": (1, E_T1, [], mc.INCONCLUSIVE, "infra:"),
    "skip": (1, E_T1, [], mc.INCONCLUSIVE, "unexpected_skip_todo_cancelled"),
    "todo": (1, E_T1, [], mc.INCONCLUSIVE, "unexpected_skip_todo_cancelled"),
    "slow": (1, E_T1, [], mc.INCONCLUSIVE, "unexpected_skip_todo_cancelled"),
    "kill_error": (1, E_T1, [{"id": "AL_probe_T3_duplicate_key", "test_pattern": "T3",
                              "regex": "Command failed: psql duplicate key", "why": "probe error mode"}],
                   mc.KILLED, "expected_assertion"),
}
VARIANTS = ("node22/{}.tap", "node22/{}.crlf.tap", "node24/{}.tap", "node24/{}.crlf.tap")


class Rule09LineEndingsAndNodeVersions(unittest.TestCase):
    def test_fixture_set_is_complete_and_line_endings_are_real(self):
        for case in CASES:
            for v in VARIANTS:
                raw = (FIX / v.format(case)).read_bytes()
                self.assertIn(b"# tests ", raw, v.format(case))
                if ".crlf." in v:
                    self.assertIn(b"\r\n", raw, v.format(case))
                    self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), v.format(case))
                else:
                    self.assertNotIn(b"\r", raw, v.format(case))

    def test_same_verdict_on_every_variant(self):
        for case, (rc, exp, al, verdict, reason) in CASES.items():
            seen = set()
            for v in VARIANTS:
                p = mc.parse_tap((FIX / v.format(case)).read_bytes())
                r = mc.classify(6, rc, p["summary"], p["failures"], exp, allowlist=al, mutant_id=case)
                self.assertEqual(r["verdict"], verdict, (v.format(case), r))
                self.assertTrue(r["reason"].startswith(reason), (v.format(case), r))
                seen.add((r["verdict"], r["reason"].split(":")[0], tuple(r["killing_tests"])))
            self.assertEqual(len(seen), 1, (case, seen))

    def test_info_glyph_summary_format(self):
        # Node 24 reporters print the summary as "ℹ tests N"; the parser must accept both prefixes.
        for case, (rc, exp, al, verdict, _) in CASES.items():
            raw = (FIX / f"node22/{case}.tap").read_text(encoding="utf-8")
            glyph = "\n".join("ℹ" + ln[1:] if mc._SUMMARY.match(ln) else ln for ln in raw.split("\n"))
            self.assertNotEqual(glyph, raw)
            for text in (glyph, glyph.replace("\n", "\r\n")):
                p = mc.parse_tap(text)
                self.assertEqual(mc.classify(6, rc, p["summary"], p["failures"], exp, allowlist=al)["verdict"], verdict, case)


class Rule10StructuredEventAdapter(unittest.TestCase):
    def ev(self, cid, bc=True, mcorr=True, exc=None, **kw):
        return {"control_id": cid, "baseline_correct": bc, "mutant_correct": mcorr, "exception": exc, **kw}

    def test_baseline_correct_to_misclassified_is_killed(self):
        r = mc.classify_structured_events("V8_m1", [self.ev("P1"), self.ev("N3", mcorr=False)])
        self.assertEqual((r["verdict"], r["killing_tests"]), (mc.KILLED, ["N3"]), r)

    def test_all_still_correct_is_survived(self):
        self.assertEqual(mc.classify_structured_events("m", [self.ev("P1"), self.ev("N1")])["verdict"], mc.SURVIVED)

    def test_any_exception_is_inconclusive_never_killed(self):
        for evs in ([self.ev("N3", mcorr=False), self.ev("P1", exc="RuntimeError: ffmpeg")],
                    [self.ev("N3", mcorr=False, exc="Traceback")],
                    [self.ev("N3", mcorr=False), self.ev("I1", mutant_verdict="ERROR_INFRA")],
                    [self.ev("N3", mcorr=False), self.ev("N4", bc=False, mcorr=False)],
                    [self.ev("N3", mcorr=False), self.ev("N3")],
                    [self.ev("N3", mcorr="no")], [], None, [object()], 42):
            r = mc.classify_structured_events("m", evs)
            self.assertEqual(r["verdict"], mc.INCONCLUSIVE, (evs, r))


class AggregateAndCli(unittest.TestCase):
    def test_exit_codes(self):
        K, S, I = {"verdict": mc.KILLED}, {"verdict": mc.SURVIVED}, {"verdict": mc.INCONCLUSIVE}
        self.assertEqual(mc.aggregate([K, K])[0], 0)
        self.assertEqual(mc.aggregate([K, S])[0], 1)
        self.assertEqual(mc.aggregate([K, K], baseline_valid=False)[0], 2)
        self.assertEqual(mc.aggregate([K, I])[0], 3)
        self.assertEqual(mc.aggregate([S, I])[0], 3)
        self.assertEqual(mc.aggregate([])[0], 3)
        self.assertEqual(mc.aggregate([{"verdict": "MAYBE"}])[0], 3)

    def test_config_validation(self):
        with self.assertRaises(ValueError):
            run(KILL, 1, [{"assertion_pattern": "A1"}])
        with self.assertRaises(ValueError):
            run(KILL, 1, allowlist=[{"id": "x", "test_pattern": "T2", "regex": "y", "why": "z", "kinds": ["type_error"]}])
        with self.assertRaises(ValueError):
            run(KILL, 1, allowlist=[{"id": "x", "test_pattern": "T2", "regex": "y"}])

    def test_cli_classify_and_aggregate(self):
        tmp = FIX / "node22"
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        out = subprocess.run([sys.executable, "-I", str(SCRIPT), "classify", "--baseline-total", "6", "--rc", "1",
                              "--tap", str(tmp / "kill.crlf.tap"), "--expected", json.dumps(E_T1), "--mutant-id", "M1"],
                             capture_output=True, text=True, env=env)
        self.assertEqual(out.returncode, 0, out.stderr)
        row = json.loads(out.stdout)
        self.assertEqual((row["verdict"], row["mutant_id"]), (mc.KILLED, "M1"))
        for key in ("verdict", "killing_tests", "assertion_ids", "counts", "reason"):
            self.assertIn(key, row)
        out = subprocess.run([sys.executable, "-I", str(SCRIPT), "classify", "--baseline-total", "6", "--rc", "1",
                              "--tap", str(tmp / "type.tap"), "--expected", json.dumps(E_T1)],
                             capture_output=True, text=True, env=env)
        self.assertEqual(out.returncode, 3, out.stdout)
        out = subprocess.run([sys.executable, "-I", str(SCRIPT), "classify", "--baseline", "--baseline-total", "6",
                              "--rc", "1", "--tap", str(tmp / "kill.tap"), "--expected", "[]"],
                             capture_output=True, text=True, env=env)
        self.assertEqual(out.returncode, 2, out.stdout)

    def test_self_check(self):
        out = subprocess.run([sys.executable, "-I", str(SCRIPT), "self-check"], capture_output=True, text=True,
                             env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertNotIn("FAIL", out.stdout)


if __name__ == "__main__":
    unittest.main()
