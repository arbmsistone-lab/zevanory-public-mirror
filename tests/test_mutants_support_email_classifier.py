"""Meta-testes do classificador de scripts/ci/mutants_support_email.py (auditor Sol 120-6).
Queda, timeout, contagem TAP incompleta, falha que não é asserção e falha fora da lista causal => INCONCLUSIVE;
só a falha por asserção na lista causal com contagem completa => KILLED. Parte sintética (saídas TAP montadas) e parte
REAL (node roda suítes mínimas que caem, travam, saem no meio ou falham fora da lista). Sem rede, sem segredo.
"""
import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mut_support", ROOT / "scripts" / "ci" / "mutants_support_email.py")
mut = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(mut)

OK = "ok {n} - {t}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n"
FAIL = ("not ok {n} - {t}\n  ---\n  duration_ms: 1\n  type: 'test'\n  failureType: 'testCodeFailure'\n  error: |-\n    x\n"
        "  code: '{code}'\n  name: '{name}'\n  ...\n")


def tap(results, total=None, cancelled=0):
    body = "TAP version 13\n"
    for i, (title, kind) in enumerate(results, 1):
        if kind == "ok":
            body += OK.format(n=i, t=title)
        elif kind == "assert":
            body += FAIL.format(n=i, t=title, code="ERR_ASSERTION", name="AssertionError")
        else:
            body += FAIL.format(n=i, t=title, code="ERR_INVALID_ARG_TYPE", name="TypeError")
    n = len(results) if total is None else total
    fails = sum(1 for _, k in results if k != "ok")
    body += f"1..{n}\n# tests {n}\n# suites 0\n# pass {len(results) - fails}\n# fail {fails}\n# cancelled {cancelled}\n# skipped 0\n# todo 0\n"
    return body


class ClassifierSynthetic(unittest.TestCase):
    ALLOW = {"causal A"}

    def test_killed_only_on_causal_assertion(self):
        out = tap([("causal A", "assert"), ("other", "ok")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, self.ALLOW, 2)[0], "KILLED")

    def test_survived_on_clean_complete_run(self):
        out = tap([("causal A", "ok"), ("other", "ok")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 0, "out": out}, self.ALLOW, 2)[0], "SURVIVED")

    def test_crash_signal_is_inconclusive(self):
        self.assertEqual(mut.classify({"timeout": False, "rc": -11, "out": ""}, self.ALLOW, 2)[0], "INCONCLUSIVE")

    def test_timeout_is_inconclusive(self):
        self.assertEqual(mut.classify({"timeout": True, "rc": None, "out": ""}, self.ALLOW, 2)[0], "INCONCLUSIVE")

    def test_incomplete_tap_is_inconclusive(self):
        out = tap([("causal A", "assert")])  # 1 de 2
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, self.ALLOW, 2)[0], "INCONCLUSIVE")
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": "TAP version 13\nnot ok 1 - causal A\n"}, self.ALLOW, 1)[0], "INCONCLUSIVE")

    def test_non_causal_failure_is_inconclusive(self):
        out = tap([("causal A", "ok"), ("other", "assert")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, self.ALLOW, 2)[0], "INCONCLUSIVE")
        out2 = tap([("causal A", "assert"), ("other", "assert")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out2}, self.ALLOW, 2)[0], "INCONCLUSIVE")

    def test_non_assertion_failure_is_inconclusive(self):
        out = tap([("causal A", "typeerror"), ("other", "ok")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, self.ALLOW, 2)[0], "INCONCLUSIVE")

    def test_cancelled_is_inconclusive(self):
        out = tap([("causal A", "assert"), ("other", "ok")], cancelled=1)
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, self.ALLOW, 2)[0], "INCONCLUSIVE")


class ClassifierReal(unittest.TestCase):
    """node de verdade: suítes mínimas no lugar de tests/support-email-forward.test.mjs."""

    def setUp(self):
        self.assertTrue(shutil.which("node"), "node ausente: classificador não pode ser provado (falha fechada)")
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "tests").mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def suite(self, body):
        (self.tmp / "tests" / "support-email-forward.test.mjs").write_text(
            'import test from "node:test";\nimport assert from "node:assert/strict";\n' + body, encoding="utf-8")
        return mut.run_suite(str(self.tmp))

    def test_real_killed_and_survived(self):
        res = self.suite('test("causal A", () => { assert.equal(1, 2); });\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "KILLED")
        res = self.suite('test("causal A", () => {});\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "SURVIVED")

    def test_real_crash_module_error(self):
        res = self.suite('import "./nao-existe.mjs";\ntest("causal A", () => {});\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "INCONCLUSIVE")

    def test_real_syntax_error(self):
        res = self.suite('test("causal A", () => { const = 1; });\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "INCONCLUSIVE")

    def test_real_incomplete_count(self):
        res = self.suite('test("causal A", () => { process.exit(1); });\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "INCONCLUSIVE")

    def test_real_timeout(self):
        old = mut.TIMEOUT
        mut.TIMEOUT = 3
        try:
            res = self.suite('test("causal A", () => { for (;;) {} });\ntest("other", () => {});\n')
        finally:
            mut.TIMEOUT = old
        self.assertTrue(res["timeout"])
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "INCONCLUSIVE")

    def test_real_non_causal_failure(self):
        res = self.suite('test("causal A", () => {});\ntest("other", () => { assert.ok(false); });\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "INCONCLUSIVE")

    def test_real_non_assertion_failure(self):
        res = self.suite('test("causal A", () => { null.x; });\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, {"causal A"}, 2)[0], "INCONCLUSIVE")


class AllowlistCoverage(unittest.TestCase):
    def test_every_mutant_has_causal_list_and_no_orphans(self):
        allow = mut.load_allow()
        self.assertEqual(sorted(allow), sorted(mut.M))
        for name, titles in allow.items():
            self.assertTrue(titles, name)


if __name__ == "__main__":
    unittest.main()
