"""Verificador ao vivo das imagens da marca: formato pela extensão (PNG e JPEG), bytes exatos.

Regressão do deploy de 12/11/2026: o #1027 colocou zevanory-proof-dec23.jpg no manifesto e o verificador exigia
assinatura PNG para todas, reprovando a imagem correta (status 200, image/jpeg, SHA-256 igual) e forçando rollback.
"""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("brand_live", ROOT / "scripts/deploy/verify-brand-assets-live.py")
MANIFEST = json.loads((ROOT / "assets/brand/export/manifest.json").read_text(encoding="utf8"))


def load():
    m = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(m)
    m.MAX_ATTEMPTS = 1
    return m


def served(name, content_type=None, body=None):
    raw = (ROOT / "assets/brand/export" / name).read_bytes() if body is None else body
    ct = content_type or ("image/jpeg" if name.endswith((".jpg", ".jpeg")) else "image/png")
    return {"status": "200", "body": raw, "curl_exit": 0, "content_type": ct, "stderr": ""}


class BrandLiveFormats(unittest.TestCase):
    def test_manifesto_tem_png_e_o_jpeg_da_prova(self):
        self.assertIn("zevanory-proof-dec23.jpg", MANIFEST)
        self.assertTrue(any(k.endswith(".png") for k in MANIFEST))

    def test_todas_as_imagens_corretas_passam_inclusive_o_jpeg(self):
        m = load()
        m.probe = lambda filename, base=None, accept="image/png": served(filename)
        m.verify()  # não levanta

    def test_jpeg_exige_assinatura_e_tipo_jpeg(self):
        m = load()
        exp = MANIFEST["zevanory-proof-dec23.jpg"]
        raw = (ROOT / "assets/brand/export/zevanory-proof-dec23.jpg").read_bytes()
        dig = hashlib.sha256(raw).hexdigest()
        self.assertTrue(m.exact_asset(served("zevanory-proof-dec23.jpg"), raw, dig, exp, "zevanory-proof-dec23.jpg"))
        self.assertTrue(m.exact_asset(served("zevanory-proof-dec23.jpg", "image/jpeg; charset=binary"), raw, dig, exp, "zevanory-proof-dec23.jpg"))
        self.assertFalse(m.exact_asset(served("zevanory-proof-dec23.jpg", "image/png"), raw, dig, exp, "zevanory-proof-dec23.jpg"))
        self.assertFalse(m.exact_asset(served("zevanory-proof-dec23.jpg", "text/html"), raw, dig, exp, "zevanory-proof-dec23.jpg"))

    def test_png_continua_exigindo_assinatura_png_e_bytes_exatos(self):
        m = load()
        name = sorted(k for k in MANIFEST if k.endswith(".png"))[0]
        exp = MANIFEST[name]
        raw = (ROOT / "assets/brand/export" / name).read_bytes()
        dig = hashlib.sha256(raw).hexdigest()
        self.assertTrue(m.exact_asset(served(name), raw, dig, exp, name))
        self.assertFalse(m.exact_asset(served(name, "image/jpeg"), raw, dig, exp, name))
        bad = bytearray(raw); bad[-1] ^= 1; bad = bytes(bad)
        self.assertFalse(m.exact_asset(served(name, body=bad), bad, hashlib.sha256(bad).hexdigest(), exp, name))

    def test_falha_real_continua_reprovando(self):
        m = load()
        m.probe = lambda filename, base=None, accept="image/png": (
            {"status": "404", "body": b"", "curl_exit": 0, "content_type": "text/html", "stderr": ""}
            if filename.endswith(".jpg") else served(filename))
        with self.assertRaises(SystemExit) as ctx:
            m.verify()
        self.assertIn("BRAND_LIVE_ASSET_UNVERIFIED zevanory-proof-dec23.jpg", str(ctx.exception))

    def test_extensao_desconhecida_reprova(self):
        m = load()
        with self.assertRaises(SystemExit):
            m.expected_format("logo.gif")


if __name__ == "__main__":
    unittest.main()
