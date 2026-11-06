"""Mutantes da prova da cadeia de publicação (Sol AVAL 271, R271-02): cada enfraquecimento da cadeia real
(aprovação, SHA esperado, rollback, encadeamento da certificação) tem de fazer scripts/release/publication_chain_check.py
falhar. Sem rede: trabalha sobre uma cópia dos YAML e do contrato."""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/release/publication_chain_check.py"
FILES = [".github/workflows/central-production-deploy.yml", ".github/workflows/zevanory-sales-public-release.yml",
         ".github/workflows/portfolio-six-target-exact-cert.yml", "scripts/portfolio_cert_contract.py"]

MUTANTS = [
    ("sales deploy job loses producao-critica", ".github/workflows/zevanory-sales-public-release.yml",
     "    environment: producao-critica  # B01 M1: efeito em produção comprovado no conteúdo do job; revisor obrigatório\n", ""),
    ("central deploy job loses producao-critica", ".github/workflows/central-production-deploy.yml",
     "  deploy:\n    environment: producao-critica", "  deploy:\n    environment: automacao"),
    ("sales verify job publishes for real", ".github/workflows/zevanory-sales-public-release.yml",
     "deploy --dry-run --strict --config wrangler.sales.toml", "deploy --strict --config wrangler.sales.toml"),
    ("central deploy not tagged with the event SHA", ".github/workflows/central-production-deploy.yml",
     '--tag="$TARGET_RUNTIME_SHA" --message', "--message"),
    ("sales readback no longer requires the SHA", ".github/workflows/zevanory-sales-public-release.yml",
     'assert h.get("release")==os.environ["GITHUB_SHA"], h\n          assert "ZEVANORY SALES" in page',
     'assert "ZEVANORY SALES" in page'),
    ("central rollback removed", ".github/workflows/central-production-deploy.yml",
     "npx --yes wrangler@4.143.0 rollback --name zevanory", "echo skip"),
    ("sales rollback no longer fails the run", ".github/workflows/zevanory-sales-public-release.yml",
     'manual recovery required"\n          fi\n          exit 1', 'manual recovery required"\n          fi\n          exit 0'),
    ("certification no longer chained to sales deploy", ".github/workflows/portfolio-six-target-exact-cert.yml",
     ', "ZEVANORY SALES public release"]', "]"),
    ("certification runs on failed deploys", ".github/workflows/portfolio-six-target-exact-cert.yml",
     "(github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'gh-pages' &&\n       (github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch'))\n    runs-on: ubuntu-latest\n    timeout-minutes: 45",
     "(github.event.workflow_run.head_branch == 'gh-pages')\n    runs-on: ubuntu-latest\n    timeout-minutes: 45"),
]


def run_check(root):
    env = {**os.environ, "PUBLICATION_CHAIN_ROOT": str(root), "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120)


class ChainCheckMutants(unittest.TestCase):
    def copy(self):
        d = tempfile.mkdtemp()
        for f in FILES:
            (pathlib.Path(d) / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / f, pathlib.Path(d) / f)
        return d

    def test_baseline_passes(self):
        d = self.copy()
        r = run_check(d)
        self.assertEqual(r.returncode, 0, r.stdout[-1500:])
        self.assertIn("CHAIN_CHECK=PASS", r.stdout)

    def test_every_mutant_is_killed(self):
        for name, f, old, new in MUTANTS:
            with self.subTest(mutant=name):
                d = self.copy()
                p = pathlib.Path(d) / f
                s = p.read_text("utf-8")
                self.assertEqual(s.count(old), 1, f"mutation not applicable: {name}")
                p.write_text(s.replace(old, new), "utf-8")
                r = run_check(d)
                self.assertNotEqual(r.returncode, 0, f"SURVIVED: {name}\n{r.stdout[-800:]}")
                self.assertIn("CHAIN_CHECK=FAIL", r.stdout + r.stderr if r.returncode == 1 else "CHAIN_CHECK=FAIL")


if __name__ == "__main__":
    unittest.main()
