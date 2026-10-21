"""O deploy canônico do site de vendas não pode gerenciar rotas da zona (diagnóstico Sol 21/10, run 39601904471).

Executa o script real do passo "Materialize release configs" num diretório temporário e confere os dois
arquivos gerados. Sem rede, sem credencial.
"""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = Path(os.environ.get("SALES_RELEASE_WORKFLOW", ROOT / ".github/workflows/zevanory-sales-public-release.yml"))
SHA = "d54c1428bdc5ec65128abc101a936d6d8d61c20b"


def materialize_script():
    doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    for job in doc["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == "Materialize release configs":
                return step["run"]
    raise AssertionError("passo Materialize release configs ausente")


def deploy_command():
    text = WORKFLOW.read_text(encoding="utf-8")
    m = re.search(r"wrangler@[\d.]+ deploy --config (\S+) --tag", text)
    assert m, "comando de promoção canônica ausente"
    return m.group(1)


class SalesDeployNoRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        (d / "wrangler.sales.toml").write_text((ROOT / "wrangler.sales.toml").read_text(encoding="utf-8"), encoding="utf-8")
        env = {**os.environ, "GITHUB_SHA": SHA, "GITHUB_RUN_ID": "4242"}
        p = subprocess.run(["bash", "-c", materialize_script()], cwd=d, env=env, capture_output=True, text=True)
        cls.rc, cls.out = p.returncode, p.stdout + p.stderr
        cls.deploy = (d / "wrangler.sales.deploy.toml").read_text(encoding="utf-8") if cls.rc == 0 else ""
        cls.preview = (d / "wrangler.sales.preview.toml").read_text(encoding="utf-8") if cls.rc == 0 else ""
        cls.source = (ROOT / "wrangler.sales.toml").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_source_still_declares_the_custom_domain(self):
        # O arquivo-fonte continua documentando o domínio (e o dry-run do job verify o valida).
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
        # Tudo o que não é rota é preservado (assets, bindings, vars).
        for line in self.source.splitlines():
            if "routes" in line or "vendas.zevanory.api.br" in line or line.strip() == "]":
                continue
            self.assertIn(line.replace("SOURCE_SHA_REPLACED_AT_DEPLOY", SHA), self.deploy)

    def test_preview_unchanged_candidate_on_workers_dev(self):
        self.assertRegex(self.preview, r'(?m)^name = "zevanory-sales-candidate-4242"$')
        self.assertRegex(self.preview, r"(?m)^workers_dev = true$")
        self.assertNotRegex(self.preview, r"(?m)^\s*routes?\s*=")

    def test_promotion_uses_the_materialized_config(self):
        self.assertEqual(deploy_command(), "wrangler.sales.deploy.toml")

    def test_post_promotion_readback_still_mandatory(self):
        doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        steps = [s for j in doc["jobs"].values() for s in j.get("steps", [])]
        rb = [s for s in steps if s.get("name") == "Verify canonical production readback"]
        self.assertEqual(len(rb), 1)
        self.assertEqual(rb[0].get("if"), "steps.promote.outputs.promoted == 'true'")
        text = rb[0]["run"]
        self.assertIn('assert h.get("release")==os.environ["GITHUB_SHA"], h', text)
        self.assertIn('BASE="https://vendas.zevanory.api.br"', text)


if __name__ == "__main__":
    unittest.main()
