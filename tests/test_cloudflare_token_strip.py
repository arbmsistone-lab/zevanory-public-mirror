"""Segredo CLOUDFLARE_API_TOKEN salvo com quebra de linha (issue #849): consumidores Python devem remover
espaços externos antes de montar o cabeçalho, sem rede e com credenciais fictícias."""
import os, sys, unittest
from unittest import mock
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts", "deploy")); sys.path.insert(0, os.path.join(ROOT, "scripts", "ops"))
import worker_secret_rotate as wsr  # noqa: E402
import backup_preserve_archive as bpa  # noqa: E402

class T(unittest.TestCase):
    def test_worker_secret_rotate_header_sem_quebra(self):
        for raw in ["tok-ficticio\n", "tok-ficticio\r\n", "  tok-ficticio  "]:
            with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": raw, "CLOUDFLARE_ACCOUNT_ID": "acc"}):
                self.assertEqual(wsr.Cloudflare(fetch=lambda *a, **k: {}).auth["Authorization"], "Bearer tok-ficticio", repr(raw))

    def test_worker_secret_rotate_token_vazio_ou_so_espacos_falha_antes_da_api(self):
        chamadas = []
        for raw, conta in [(" \n ", "acc"), ("", "acc"), ("tok-ficticio", "  ")]:
            with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": raw, "CLOUDFLARE_ACCOUNT_ID": conta}), \
                 mock.patch.object(wsr, "Cloudflare", lambda *a, **k: chamadas.append(1)), \
                 mock.patch.object(sys, "argv", ["worker_secret_rotate.py", "--verify"]):
                self.assertEqual(wsr.main(), 1, repr((raw, conta)))
        self.assertEqual(chamadas, [], "nenhuma chamada à API com credencial inválida")

    def test_backup_preserve_repassa_token_limpo_e_vazio_falha(self):
        seen = {}
        with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "tok-ficticio\r\n"}), \
             mock.patch.object(bpa, "mode_inspect", lambda args, token: seen.setdefault("t", token)):
            bpa.main(["inspect", "--day", "2026-10-14"])
        self.assertEqual(seen["t"], "tok-ficticio")
        with mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": " \n "}), self.assertRaises(SystemExit):
            bpa.main(["inspect", "--day", "2026-10-14"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
