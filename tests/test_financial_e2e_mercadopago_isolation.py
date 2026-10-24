"""R4: scripts/financial_e2e_mercadopago.py (signed Mercado Pago webhooks) may target only the isolated certification
Worker, never *.zevanory.api.br. Causal: the previous script hard-coded APP = "https://zevanory.api.br"."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "scripts/financial_e2e_mercadopago.py"
PROBE = ("import runpy,sys\n"
         "try:\n    g=runpy.run_path(sys.argv[1], run_name='r4_probe')\n"
         "except SystemExit as e:\n    print('EXIT', e); sys.exit(0)\n"
         "print('LOADED', g['APP'])\n")


def load(url):
    env = {k: v for k, v in os.environ.items() if k != "CERTIFICATION_SANDBOX_URL"}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if url is not None:
        env["CERTIFICATION_SANDBOX_URL"] = url
    p = subprocess.run([sys.executable, "-I", "-c", PROBE, str(SCRIPT)], env=env, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=60)
    return p.stdout.strip() + p.stderr.strip()


class MercadoPagoIsolation(unittest.TestCase):
    def test_m1_production_hosts_refused(self):
        for url in ("https://zevanory.api.br", "https://edge.zevanory.api.br", "https://vendas.zevanory.api.br/"):
            self.assertIn("EXIT R4_PRODUCTION_HOST_DENIED", load(url), f"[MPI1] {url} must be refused")

    def test_m2_missing_or_foreign_target_refused(self):
        for url in (None, "", "https://example.com"):
            self.assertIn("EXIT R4_ISOLATED_CERTIFICATION_WORKER_REQUIRED", load(url), f"[MPI2] {url!r} must be refused")

    def test_m3_isolated_certification_worker_accepted(self):
        self.assertIn("LOADED https://zevanory-certification.girolocal-rb.workers.dev",
                      load("https://zevanory-certification.girolocal-rb.workers.dev"), "[MPI3] isolated Worker accepted")


if __name__ == "__main__":
    unittest.main()
