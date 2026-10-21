"""O deploy canônico do site de vendas não pode gerenciar rotas da zona (diagnóstico Sol 21/10, run 39601904471).

Executa o script real scripts/ci/materialize_sales_configs.py num diretório temporário e confere os arquivos
gerados; confere que os jobs verify e deploy usam esse mesmo script e que o verify faz dry-run da config
canônica exata (contestação Sol R2). Sem rede, sem credencial.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = Path(os.environ.get("SALES_RELEASE_WORKFLOW", ROOT / ".github/workflows/zevanory-sales-public-release.yml"))
SCRIPT = Path(os.environ.get("SALES_MATERIALIZE_SCRIPT", ROOT / "scripts/ci/materialize_sales_configs.py"))
SHA = "d54c1428bdc5ec65128abc101a936d6d8d61c20b"


def jobs():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]


def step(job, name):
    hits = [s for s in jobs()[job]["steps"] if s.get("name") == name]
    assert len(hits) == 1, f"{job}: passo {name!r} ausente ou duplicado"
    return hits[0]


class SalesDeployNoRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        shutil.copy(ROOT / "wrangler.sales.toml", d / "wrangler.sales.toml")
        env = {**os.environ, "GITHUB_SHA": SHA, "GITHUB_RUN_ID": "4242"}
        p = subprocess.run(["python3", str(SCRIPT)], cwd=d, env=env, capture_output=True, text=True)
        cls.rc, cls.out = p.returncode, p.stdout + p.stderr
        cls.deploy = (d / "wrangler.sales.deploy.toml").read_text(encoding="utf-8") if cls.rc == 0 else ""
        cls.preview = (d / "wrangler.sales.preview.toml").read_text(encoding="utf-8") if cls.rc == 0 else ""
        cls.source = (ROOT / "wrangler.sales.toml").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_source_still_declares_the_custom_domain(self):
        self.assertIn('pattern = "vendas.zevanory.api.br", custom_domain = true', self.source)

    def test_materialize_runs(self):
        self.assertEqual(self.rc, 0, self.out)

    def test_canonical_deploy_config_does_not_manage_routes(self):
        self.assertNotRegex(self.deploy, r"(?m)^\s*routes?\s*=")
        self.assertNotIn("vendas.zevanory.api.br", self.deploy)
        self.assertRegex(self.deploy, r"(?m)^workers_dev = false$")

    def test_canonical_identity_and_release_sha(self):
        self.assertRegex(self.deploy, r'(?m)^name = "zevanory-sales-public"$')
        self.assertIn(SHA, self.deploy)
        self.assertNotIn("SOURCE_SHA_REPLACED_AT_DEPLOY", self.deploy)
        self.assertRegex(self.deploy, r'(?m)^account_id = "1b26415802588185a86c1d4d3ebf5bdb"$')
        for line in self.source.splitlines():
            if "routes" in line or "vendas.zevanory.api.br" in line or line.strip() == "]":
                continue
            self.assertIn(line.replace("SOURCE_SHA_REPLACED_AT_DEPLOY", SHA), self.deploy)

    def test_preview_unchanged_candidate_on_workers_dev(self):
        self.assertRegex(self.preview, r'(?m)^name = "zevanory-sales-candidate-4242"$')
        self.assertRegex(self.preview, r"(?m)^workers_dev = true$")
        self.assertNotRegex(self.preview, r"(?m)^\s*routes?\s*=")

    def test_both_jobs_use_the_same_materialize_script(self):
        self.assertEqual(step("deploy", "Materialize release configs")["run"].strip(),
                         "python3 scripts/ci/materialize_sales_configs.py")
        verify = step("verify", "Cloudflare dry-run of the exact canonical deploy config (no routes)")["run"]
        self.assertIn("python3 scripts/ci/materialize_sales_configs.py", verify)

    def test_verify_dry_runs_the_exact_canonical_config_fail_closed(self):
        run = step("verify", "Cloudflare dry-run of the exact canonical deploy config (no routes)")["run"]
        self.assertIn("set -euo pipefail", run)
        self.assertRegex(run, r"wrangler@4\.143\.0 deploy --dry-run --strict --config wrangler\.sales\.deploy\.toml")
        # "! cmd" não dispara set -e em bash: proibido nas checagens.
        self.assertNotRegex(run, r"(?m)^\s*! ")
        self.assertRegex(run, r"if grep -Eq '\^\[\[:space:\]\]\*routes\?.*wrangler\.sales\.deploy\.toml; then .*exit 1; fi")
        self.assertRegex(run, r"if grep -Eiq 'vendas.*custom domain' /tmp/canonical-dry-run\.txt; then .*exit 1; fi")

    def test_promotion_uses_the_materialized_config(self):
        run = step("deploy", "Promote exact candidate source to canonical domain")["run"]
        self.assertRegex(run, r"wrangler@[\d.]+ deploy --config wrangler\.sales\.deploy\.toml --tag")

    def test_post_promotion_readback_still_mandatory(self):
        rb = step("deploy", "Verify canonical production readback")
        self.assertEqual(rb.get("if"), "steps.promote.outputs.promoted == 'true'")
        self.assertIn('assert h.get("release")==os.environ["GITHUB_SHA"], h', rb["run"])
        self.assertIn('BASE="https://vendas.zevanory.api.br"', rb["run"])

    def test_workflow_triggers_on_script_change(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(text.count('- "scripts/ci/materialize_sales_configs.py"'), 2)


if __name__ == "__main__":
    unittest.main()
