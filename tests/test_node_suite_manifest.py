"""Contagem da suíte Node derivada do manifesto (contestação Sol C071-3): scripts/ci/node_suite_check.py.

Cada mutante monta uma mini-suíte REAL num diretório temporário, roda `node --test` com os mesmos dois
reporters do gate (TAP + scripts/ci/node-suite-reporter.mjs) e prova que o verificador falha. Sem rede,
sem segredos, sem PostgreSQL. node ausente => falha (nunca pula).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/ci/node_suite_check.py"
REPORTER = ROOT / "scripts/ci/node-suite-reporter.mjs"
WORKFLOW = ROOT / ".github/workflows/trava-vendas-integracao-postgres.yml"
MANIFEST = ROOT / "tests/node-suite.manifest"

A = 'import test from "node:test";\ntest("a1", () => {});\ntest("a2", async (t) => { await t.test("a2.sub", () => {}); });\n'
B = 'import test, { describe, it } from "node:test";\ndescribe("grupo", () => { it("b1", () => {}); it("b2", () => {}); });\n'


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)


class NodeSuiteManifest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(shutil.which("node"), "node ausente: o verificador não pode ser provado (falha fechada)")
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "tests").mkdir()
        self.write("tests/a.test.mjs", A)
        self.write("tests/b.test.mjs", B)
        self.manifest("tests/a.test.mjs 3", "tests/b.test.mjs 2")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, text):
        (self.tmp / rel).write_text(text, encoding="utf-8")

    def manifest(self, *lines):
        self.write("tests/node-suite.manifest", "# comentário\n" + "\n".join(lines) + "\n")

    def suite(self, files=None):
        files = files or sorted(str(p.relative_to(self.tmp)) for p in (self.tmp / "tests").glob("*.test.mjs"))
        p = run(["node", "--test", "--test-reporter=tap", "--test-reporter-destination=all.txt",
                 f"--test-reporter={REPORTER.as_uri()}", "--test-reporter-destination=per-file.json", *files], self.tmp)
        return p

    def check(self):
        return run([sys.executable, str(CHECK), "--manifest", "tests/node-suite.manifest", "--tap", "all.txt",
                    "--per-file", "per-file.json"], self.tmp)

    def assertKilled(self, code):
        r = self.check()
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn(f"::error title={code}::", r.stdout)
        self.assertNotIn("NODE_SUITE_MANIFEST=PASS", r.stdout)
        return r

    def test_control_exact_manifest_passes(self):
        self.assertEqual(self.suite().returncode, 0)
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("NODE_SUITE_MANIFEST=PASS expected=5 ", r.stdout)

    def test_mutant_manifest_off_by_one_up(self):
        self.suite(); self.manifest("tests/a.test.mjs 4", "tests/b.test.mjs 2")
        self.assertKilled("FILE_COUNT_MISMATCH"); self.assertKilled("TOTAL_MISMATCH")

    def test_mutant_manifest_off_by_one_down(self):
        self.suite(); self.manifest("tests/a.test.mjs 3", "tests/b.test.mjs 1")
        self.assertKilled("FILE_COUNT_MISMATCH"); self.assertKilled("PASS_MISMATCH")

    def test_mutant_test_file_silently_dropped_from_the_run(self):
        self.suite(["tests/a.test.mjs"])  # b.test.mjs existe e está no manifesto, mas não rodou
        self.assertKilled("FILE_DROPPED")

    def test_mutant_skip_added(self):
        self.write("tests/b.test.mjs", B.replace('it("b2", () => {})', 'it("b2", { skip: true }, () => {})'))
        self.suite()
        self.assertKilled("TAP_SKIPPED"); self.assertKilled("FILE_SKIP")

    def test_mutant_todo_added(self):
        self.write("tests/a.test.mjs", A.replace('test("a1", () => {})', 'test("a1", { todo: true }, () => {})'))
        self.suite()
        self.assertKilled("TAP_TODO"); self.assertKilled("FILE_TODO")

    def test_mutant_manifest_missing(self):
        self.suite(); (self.tmp / "tests/node-suite.manifest").unlink()
        self.assertKilled("MANIFEST_MISSING")

    def test_mutant_new_file_not_in_manifest(self):
        self.write("tests/c.test.mjs", 'import test from "node:test";\ntest("c1", () => {});\n')
        self.suite()
        self.assertKilled("MANIFEST_UNLISTED_FILE")

    def test_mutant_exit_before_tests_is_not_counted_as_a_pass(self):
        # O node reporta um único "pass" no nível do arquivo; com manifesto 1 a soma bateria. Tem de falhar.
        self.write("tests/b.test.mjs", 'import test from "node:test";\ntest("b1", () => {});\nprocess.exit(0);\n')
        self.manifest("tests/a.test.mjs 3", "tests/b.test.mjs 1")
        self.suite()
        self.assertKilled("FILE_FILE_LEVEL")

    def test_mutant_failing_test(self):
        self.write("tests/a.test.mjs", A.replace('test("a1", () => {})', 'test("a1", () => { throw new Error("x"); })'))
        self.suite()
        self.assertKilled("TAP_FAIL")

    def test_mutant_malformed_or_duplicate_manifest(self):
        self.suite()
        self.manifest("tests/a.test.mjs 3", "tests/a.test.mjs 3", "tests/b.test.mjs 2")
        self.assertKilled("MANIFEST_DUPLICATE")
        self.manifest("tests/a.test.mjs 3", "tests/b.test.mjs dois")
        self.assertKilled("MANIFEST_BAD_LINE")
        self.manifest("tests/a.test.mjs 3", "tests/b.test.mjs 0")
        self.assertKilled("MANIFEST_BAD_COUNT")
        self.manifest()
        self.assertKilled("MANIFEST_EMPTY")

    def test_workflow_derives_the_count_from_the_manifest(self):
        wf = WORKFLOW.read_text(encoding="utf-8")
        # nenhum literal para a suíte completa: só o verificador
        self.assertNotRegex(wf, r'"# (tests|pass) [0-9]+" all\.txt')
        self.assertIn("--test-reporter=./scripts/ci/node-suite-reporter.mjs --test-reporter-destination=per-file.json", wf)
        self.assertIn("python3 scripts/ci/node_suite_check.py --manifest tests/node-suite.manifest --tap all.txt --per-file per-file.json", wf)
        self.assertIn("tests/*.test.mjs | tee all.txt", wf)
        for p in ("tests/*.test.mjs", "tests/node-suite.manifest", "tests/test_node_suite_manifest.py",
                  "scripts/ci/node_suite_check.py", "scripts/ci/node-suite-reporter.mjs"):
            self.assertIn(f'      - "{p}"\n', wf, p)
        self.assertIn("python3 -m unittest tests.test_node_suite_manifest", wf)
        self.assertNotIn("secrets.", wf)

    def test_repository_manifest_lists_exactly_the_suite_files(self):
        lines = [l for l in MANIFEST.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
        names = [l.split(" ")[0] for l in lines]
        self.assertEqual(names, sorted(names), "manifesto em ordem alfabética (PRs paralelas não disputam linhas)")
        for l in lines:
            self.assertRegex(l, r"^tests/[A-Za-z0-9._-]+\.test\.mjs [1-9][0-9]*$")
        disk = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests").glob("*.test.mjs"))
        self.assertEqual(names, disk)


if __name__ == "__main__":
    unittest.main()
