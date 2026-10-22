"""Guarda de higiene: bytecode Python nunca rastreado (scripts/ci/no_tracked_bytecode.py).

Cada mutante monta um repositório git temporário (sem rede, sem commit, sem identidade) e prova que o guarda
falha quando deveria. O último teste roda o guarda contra este próprio repositório.
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "scripts/ci/no_tracked_bytecode.py"
WORKFLOW = ROOT / ".github/workflows/repo-hygiene-bytecode.yml"


def run(*args, cwd=None):
    return subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, check=False)


class NoTrackedBytecode(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.assertEqual(run("git", "init", "-q", str(self.tmp)).returncode, 0)
        shutil.copy(ROOT / ".gitignore", self.tmp / ".gitignore")
        (self.tmp / "ok.py").write_text("x = 1\n")
        self.add(".gitignore", "ok.py")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add(self, *paths, force=False):
        r = run("git", "add", *(["-f"] if force else []), "--", *paths, cwd=self.tmp)
        self.assertEqual(r.returncode, 0, r.stderr)

    def guard(self):
        return run(sys.executable, str(GUARD), "--repo", str(self.tmp))

    def put(self, rel, data=b"\x00bytecode"):
        p = self.tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return rel

    def test_clean_repo_passes(self):
        r = self.guard()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("TRACKED_BYTECODE=0 GITIGNORE_GAPS=0", r.stdout)

    def test_mutant_tracked_pyc_in_pycache_fires(self):
        # o caso real: tests/__pycache__/test_sandbox_guards.cpython-313.pyc forçado no índice
        self.add(self.put("tests/__pycache__/test_sandbox_guards.cpython-313.pyc"), force=True)
        r = self.guard()
        self.assertEqual(r.returncode, 1)
        self.assertIn("TRACKED_BYTECODE::tests/__pycache__/test_sandbox_guards.cpython-313.pyc", r.stdout)

    def test_mutant_loose_pyc_and_pyo_fire(self):
        self.add(self.put("scripts/a.pyc"), self.put("b.pyo"), force=True)
        r = self.guard()
        self.assertEqual(r.returncode, 1)
        self.assertIn("TRACKED_BYTECODE=2", r.stdout)

    def test_mutant_non_bytecode_file_inside_pycache_fires(self):
        self.add(self.put("pkg/__pycache__/README", b"x"), force=True)
        self.assertEqual(self.guard().returncode, 1)

    def test_mutant_gitignore_rule_removed_fires(self):
        (self.tmp / ".gitignore").write_text("node_modules/\n")
        r = self.guard()
        self.assertEqual(r.returncode, 1)
        self.assertIn("GITIGNORE_MISSING_BYTECODE_RULE", r.stdout)

    def test_lookalike_names_are_not_flagged(self):
        self.add(self.put("docs/pycache-notes.md", b"x"), self.put("a.pyc.txt", b"x"), self.put("pycache_/x.py", b"x"))
        self.assertEqual(self.guard().returncode, 0)

    def test_not_a_git_repo_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(run(sys.executable, str(GUARD), "--repo", d).returncode, 1)

    def test_workflow_runs_on_every_pull_request_without_secrets(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        doc = yaml.safe_load(text)
        on = doc.get("on", doc.get(True))
        self.assertEqual(list(on), ["pull_request"])
        self.assertFalse((on["pull_request"] or {}).get("paths"), "sem filtro de caminho: o guarda roda em toda PR")
        self.assertEqual(doc["permissions"], {"contents": "read"})
        self.assertNotIn("secrets.", text)
        self.assertIn("python3 scripts/ci/no_tracked_bytecode.py", text)
        self.assertIn("tests.test_no_tracked_bytecode", text)

    def test_this_repository_is_clean(self):
        r = run(sys.executable, str(GUARD), "--repo", str(ROOT))
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main()
