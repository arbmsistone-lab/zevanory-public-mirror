"""R4: the Stripe sandbox E2E may target only the isolated certification Worker (never *.zevanory.api.br), and its
workflow cannot run without an explicit owner approval gate. Causal: on the previous script (APP hard-coded to
https://zevanory.api.br) and workflow (no gate, webhook and secrets on the production Worker) these tests fail."""
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/financial_e2e_stripe.py"
WORKFLOW = ROOT / ".github/workflows/financial-e2e-stripe.yml"
PROBE = ("import runpy,sys\n"
         "try:\n    g=runpy.run_path(sys.argv[1], run_name='r4_probe')\n"
         "except SystemExit as e:\n    print('EXIT', e); sys.exit(0)\n"
         "print('LOADED', g['APP'])\n")


def load(url):
    env = {k: v for k, v in os.environ.items() if k != "CERTIFICATION_SANDBOX_URL"}
    env.update({"STRIPE_SECRET_KEY": "sk_test_fixture", "CERTIFICATION_E2E_TOKEN": "x" * 40, "EXPECTED_SHA": "a" * 40,
                "PYTHONDONTWRITEBYTECODE": "1"})
    if url is not None:
        env["CERTIFICATION_SANDBOX_URL"] = url
    p = subprocess.run([sys.executable, "-I", "-c", PROBE, str(SCRIPT)], env=env, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=60)
    return p.stdout.strip() + p.stderr.strip()


class StripeIsolation(unittest.TestCase):
    def test_s1_production_hosts_refused(self):
        for url in ("https://zevanory.api.br", "https://edge.zevanory.api.br", "https://vendas.zevanory.api.br/"):
            self.assertIn("EXIT R4_PRODUCTION_HOST_DENIED", load(url), f"[S1a] {url} must be refused")

    def test_s2_missing_or_foreign_target_refused(self):
        for url in (None, "", "https://example.com", "http://zevanory-certification.x.workers.dev"):
            self.assertIn("EXIT R4_ISOLATED_CERTIFICATION_WORKER_REQUIRED", load(url), f"[S2a] {url!r} must be refused")

    def test_s3_isolated_certification_worker_accepted(self):
        out = load("https://zevanory-certification.girolocal-rb.workers.dev")
        self.assertIn("LOADED https://zevanory-certification.girolocal-rb.workers.dev", out, "[S3a] isolated Worker accepted")

    def test_s4_workflow_gated_and_never_targets_production(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        steps = text.split("\n    steps:\n", 1)[1]
        first = steps.split("\n      - ", 2)
        self.assertIn("R4 owner approval gate", first[0], "[S4a] the owner approval gate must be the first step")
        self.assertIn("vars.R4_FINANCIAL_E2E_STRIPE_OWNER_APPROVAL", first[0], "[S4b] gate bound to its variable")
        self.assertRegex(first[0], r"\bexit 1\b", "[S4c] gate fails closed")
        self.assertIn("R4_PRODUCTION_HOST_DENIED", first[1], "[S4d] production targets refused before any call")
        code = re.sub(r"^\s*#.*$", "", text, flags=re.M)
        self.assertNotRegex(code, r"https://(?:[a-z0-9-]+\.)*zevanory\.api\.br/", "[S4e] no production URL in the job")
        self.assertNotRegex(code, r"secret bulk \S+ --name zevanory\s*$", "[S4f] never writes secrets to the production Worker")


if __name__ == "__main__":
    unittest.main()
