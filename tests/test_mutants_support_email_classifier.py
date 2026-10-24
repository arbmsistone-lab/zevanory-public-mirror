"""Meta-testes do classificador de scripts/ci/mutants_support_email.py (auditor Sol 120-6).
Queda, timeout, contagem TAP incompleta, falha que não é asserção, falha só em teste secundário e falha fora da lista
causal => INCONCLUSIVE; KILLED exige asserção em teste PRIMÁRIO e nenhuma falha fora de primary ∪ secondary. A lista
causal é validada antes (entrada sem justificativa, teste inexistente, lista larga sem broad_reason => recusa). Parte sintética (saídas TAP montadas) e parte
REAL (node roda suítes mínimas que caem, travam, saem no meio ou falham fora da lista). Sem rede, sem segredo.
"""
import importlib.util
import json
import os
import re
import subprocess
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


def entry(primary=("causal A",), secondary=()):
    return {"change": "x", "primary": [{"test": t, "why": "direto"} for t in primary], "secondary": [{"test": t, "why": "precondição"} for t in secondary]}


class ClassifierSynthetic(unittest.TestCase):
    ALLOW = entry()

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

    def test_secondary_only_failure_is_inconclusive(self):
        out = tap([("causal A", "ok"), ("other", "assert")])
        e = entry(secondary=("other",))
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, e, 2), ("INCONCLUSIVE", "falha só em secundário (nenhuma asserção primária)"))

    def test_primary_plus_justified_secondary_is_killed(self):
        out = tap([("causal A", "assert"), ("other", "assert")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, entry(secondary=("other",)), 2)[0], "KILLED")

    def test_unrelated_failure_is_inconclusive(self):
        out = tap([("causal A", "assert"), ("unrelated", "assert")])
        self.assertEqual(mut.classify({"timeout": False, "rc": 1, "out": out}, entry(secondary=("other",)), 2)[0], "INCONCLUSIVE")

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
        self.assertEqual(mut.classify(res, entry(), 2)[0], "KILLED")
        res = self.suite('test("causal A", () => {});\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, entry(), 2)[0], "SURVIVED")

    def test_real_crash_module_error(self):
        res = self.suite('import "./nao-existe.mjs";\ntest("causal A", () => {});\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, entry(), 2)[0], "INCONCLUSIVE")

    def test_real_syntax_error(self):
        res = self.suite('test("causal A", () => { const = 1; });\n')
        self.assertEqual(mut.classify(res, entry(), 2)[0], "INCONCLUSIVE")

    def test_real_incomplete_count(self):
        res = self.suite('test("causal A", () => { process.exit(1); });\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, entry(), 2)[0], "INCONCLUSIVE")

    def test_real_timeout(self):
        old = mut.TIMEOUT
        mut.TIMEOUT = 3
        try:
            res = self.suite('test("causal A", () => { for (;;) {} });\ntest("other", () => {});\n')
        finally:
            mut.TIMEOUT = old
        self.assertTrue(res["timeout"])
        self.assertEqual(mut.classify(res, entry(), 2)[0], "INCONCLUSIVE")

    def test_real_non_causal_failure(self):
        res = self.suite('test("causal A", () => {});\ntest("other", () => { assert.ok(false); });\n')
        self.assertEqual(mut.classify(res, entry(), 2)[0], "INCONCLUSIVE")

    def test_real_non_assertion_failure(self):
        res = self.suite('test("causal A", () => { null.x; });\ntest("other", () => {});\n')
        self.assertEqual(mut.classify(res, entry(), 2)[0], "INCONCLUSIVE")


def titles_of(rel):
    return [re.match(r'^test\("((?:[^"\\]|\\.)*)"', l).group(1) for l in (ROOT / rel).read_text(encoding="utf-8").split("\n") if l.startswith('test("')]


class AllowlistValidation(unittest.TestCase):
    def test_shipped_lists_are_valid_and_complete(self):
        unit = mut.load_allow(ROOT / "scripts" / "ci" / "mutants_support_email_allow.json")
        self.assertEqual(mut.validate_allow(unit, mut.M, set(titles_of("tests/support-email-forward.test.mjs"))), [])
        pg = mut.load_allow(ROOT / "scripts" / "ci" / "mutants_support_email_pg_allow.json")
        self.assertEqual(mut.validate_allow(pg, mut.M_PG, set(titles_of("tests/integration/support-outbox-postgres.test.mjs"))), [])

    def test_causality_doc_lists_every_mutant(self):
        doc = (ROOT / "docs" / "evidence" / "support-email-mutant-causality.md").read_text(encoding="utf-8")
        for name in list(mut.M) + list(mut.M_PG):
            self.assertIn(f"| {name.split(' ')[0]} |", doc, name)

    def test_missing_justification_rejected(self):
        bad = {"m": {"change": "x", "primary": [{"test": "A", "why": ""}], "secondary": []}}
        self.assertTrue(any("sem justificativa" in e for e in mut.validate_allow(bad, {"m": 1}, {"A"})))
        bad2 = {"m": {"change": "x", "primary": [{"test": "A", "why": "ok"}], "secondary": [{"test": "B"}]}}
        self.assertTrue(any("sem justificativa" in e for e in mut.validate_allow(bad2, {"m": 1}, {"A", "B"})))

    def test_broad_list_without_reason_rejected(self):
        e = {"change": "x", "primary": [{"test": t, "why": "d"} for t in "ABC"], "secondary": [{"test": t, "why": "s"} for t in "DE"]}
        self.assertTrue(any("sem broad_reason" in x for x in mut.validate_allow({"m": e}, {"m": 1}, set("ABCDE"))))
        self.assertEqual(mut.validate_allow({"m": {**e, "broad_reason": "pré-condição comum"}}, {"m": 1}, set("ABCDE")), [])

    def test_primary_bounds_unknown_test_and_orphans_rejected(self):
        self.assertTrue(mut.validate_allow({"m": {"change": "x", "primary": [], "secondary": []}}, {"m": 1}, set()))
        self.assertTrue(mut.validate_allow({"m": {"change": "x", "primary": [{"test": "Z", "why": "d"}]}}, {"m": 1}, {"A"}))
        self.assertTrue(mut.validate_allow({}, {"m": 1}, {"A"}))
        self.assertTrue(mut.validate_allow({"m": entry(primary=("A",)), "orphan": entry(primary=("A",))}, {"m": 1}, {"A"}))

    def test_runner_refuses_to_start_with_unjustified_entry(self):
        self.assertTrue(shutil.which("node"))
        allow = json.loads((ROOT / "scripts" / "ci" / "mutants_support_email_allow.json").read_text(encoding="utf-8"))
        first = sorted(allow)[0]
        allow[first]["primary"][0]["why"] = ""
        tmp = Path(tempfile.mkdtemp())
        try:
            f = tmp / "allow.json"
            f.write_text(json.dumps(allow, ensure_ascii=False), encoding="utf-8")
            env = {**os.environ, "SUPPORT_MUTANTS_ALLOW_FILE": str(f), "PYTHONDONTWRITEBYTECODE": "1"}
            p = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "mutants_support_email.py")], capture_output=True, text=True, encoding="utf-8", env=env, timeout=300, stdin=subprocess.DEVNULL)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        self.assertEqual(p.returncode, 2, p.stdout[-400:])
        self.assertIn("ALLOWLIST_INVALID", p.stdout)
        self.assertNotIn("MUTANT ", p.stdout, "nenhum mutante roda com lista inválida")


if __name__ == "__main__":
    unittest.main()
