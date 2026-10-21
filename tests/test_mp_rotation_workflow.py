"""Guarda estática do workflow de troca do token Mercado Pago (achados MP-01..MP-03 do Sol, 21/10/2026).

Nenhum teste aqui lê, grava ou dispara credenciais: só analisa o YAML e executa a expressão jq do
ponto de retorno contra respostas de exemplo no formato documentado pela Cloudflare
(GET /accounts/{id}/workers/scripts/{name}/deployments -> result.deployments[0].versions[]).
"""
import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = Path(os.environ.get("MP_ROTATION_WORKFLOW", ROOT / ".github/workflows/mercadopago-production-token-rotate.yml"))


def load():
    text = WORKFLOW.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    jobs = list(doc["jobs"].values())
    assert len(jobs) == 1, "o workflow deve ter um único job"
    return text, jobs[0]


def step_index(steps, needle):
    hits = [i for i, s in enumerate(steps) if needle in str(s.get("run", ""))]
    assert hits, f"passo com {needle!r} não encontrado"
    return hits[0]


class MpRotationWorkflow(unittest.TestCase):
    def setUp(self):
        self.text, self.job = load()
        self.steps = self.job["steps"]

    def test_mp01_single_cloudflare_token_source(self):
        self.assertNotIn("CLOUDFLARE_PUBLIC_OWNER_API_TOKEN", self.text)
        self.assertEqual(self.job["env"]["CLOUDFLARE_API_TOKEN"], "${{ secrets.CLOUDFLARE_API_TOKEN }}")
        self.assertEqual(self.job.get("environment"), "producao-critica")

    def test_mp02_operational_reads_happen_before_the_write(self):
        put = step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")
        for path in ("/v1/payments/search?limit=1", "/v1/payment_methods"):
            self.assertLess(step_index(self.steps, path), put, f"{path} tem de rodar antes do secret put")
        check = self.steps[step_index(self.steps, "/v1/payment_methods")]["run"]
        loop = check[check.index('for path in'):check.index('done', check.index('for path in'))]
        self.assertRegex(loop, r'test "\$code" = "200" \|\| \{ echo "::error title=MP_OPERATIONAL_CHECK::[^}]*exit 1; \}')
        # Só leitura: nenhum método de escrita contra a API do Mercado Pago.
        self.assertNotRegex(self.text, r"-X\s*(POST|PUT|DELETE|PATCH)[^\n]*mercadopago")

    def test_mp03_rollback_point_captured_before_write(self):
        put = step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")
        rec = step_index(self.steps, 'PREV_VERSION_ID=$prev')
        self.assertLess(rec, put)
        self.assertIn("/workers/scripts/zevanory/deployments", self.steps[rec]["run"])
        self.assertIn("^[0-9a-f-]{36}$", self.steps[rec]["run"], "versão anterior tem de ser validada (fail-closed)")

    def test_mp03_rollback_runs_only_after_a_post_write_failure(self):
        last = self.steps[-1]
        cond = last.get("if", "")
        for token in ("failure()", "env.ROTATED_AT != ''", "env.PREV_VERSION_ID != ''"):
            self.assertIn(token, cond)
        self.assertRegex(last["run"], r'wrangler@4\.143\.0 rollback "\$PREV_VERSION_ID" --name zevanory')
        self.assertRegex(last["run"], r'echo "::warning title=MP_ROTATION_ROLLED_BACK::[^"]*NAO_COMPROVADO',
                         "o limite (restauração do valor do segredo) tem de aparecer no resultado do run")
        put = self.steps[step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")]["run"]
        self.assertLess(put.index("secret put"), put.index("ROTATED_AT="), "ROTATED_AT só depois da gravação")

    def test_every_cloudflare_step_strips_whitespace_from_the_token(self):
        for s in self.steps:
            run = str(s.get("run", ""))
            if "CLOUDFLARE_API_TOKEN" in run or "wrangler" in run:
                self.assertIn("tr -d '[:space:]'", run, s.get("name"))

    def test_wait_is_bounded_below_previous_70_minutes(self):
        m = re.search(r"deadline=\$\(\(SECONDS \+ (\d+)\)\)", self.text)
        self.assertIsNotNone(m)
        self.assertLessEqual(int(m.group(1)), 2400)
        self.assertLessEqual(int(self.job["timeout-minutes"]), 55)

    def test_secret_value_is_never_printed(self):
        self.assertNotRegex(self.text, r"echo[^\n]*\$\{?MERCADOPAGO_PROD_ACCESS_TOKEN")
        self.assertNotRegex(self.text, r"set -[a-z]*x")
        self.assertIn('printf \'%s\' "$MERCADOPAGO_PROD_ACCESS_TOKEN" |', self.text)

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_rollback_point_jq_against_documented_shapes(self):
        run = self.steps[step_index(self.steps, 'PREV_VERSION_ID=$prev')]["run"]
        expr = re.search(r"jq -r '([^']+)' /tmp/deployments.json", run).group(1)
        a, b = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
        cases = {
            "single": ({"result": {"deployments": [{"versions": [{"version_id": a, "percentage": 100}]}]}}, a),
            "latest_first": ({"result": {"deployments": [{"versions": [{"version_id": b, "percentage": 100}]},
                                                         {"versions": [{"version_id": a, "percentage": 100}]}]}}, b),
            # Implantação gradual: não há versão a 100% => vazio => o passo falha (fail-closed).
            "gradual": ({"result": {"deployments": [{"versions": [{"version_id": a, "percentage": 60},
                                                                  {"version_id": b, "percentage": 40}]}]}}, ""),
            "empty": ({"result": {"deployments": []}}, ""),
        }
        for name, (payload, want) in cases.items():
            got = subprocess.run(["jq", "-r", expr], input=json.dumps(payload), capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual(got, want, name)


if __name__ == "__main__":
    unittest.main()
