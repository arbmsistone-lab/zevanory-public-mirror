"""Ensaio sem rede do roteiro de leitura pós-publicação (Sol AVAL 271, R271-02/R271-03).

Produção falsa construída a partir da árvore deste SHA (sales-public/*.html, pages-mirror/*.html): fechada => PASS.
Cada desvio de NO-GO (vendas abertas, checkout próprio com formulário, API de checkout atendendo, Hotmart/assinatura
redirecionando ao pagamento, link de pagamento em página P12/P15, SHA errado num Worker, título divergente) => FAIL,
HOMOLOGATION=BLOCKED e saída 1. Também prova que o roteiro só usa GET e nunca segue redirecionamentos de pagamento.
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("readback", ROOT / "scripts/release/post_publication_readback.py")
RB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RB)
SHA = "a" * 40
H = {"strict-transport-security": "max-age=1", "content-security-policy": "default-src 'self'",
     "x-content-type-options": "nosniff"}


class FakeProd:
    def __init__(self, **over):
        self.over = over
        self.calls = []

    def __call__(self, url, follow=True, method="GET"):
        self.calls.append((method, url, follow))
        o = self.over
        if url in o:
            return o[url]
        if url.endswith("/api/health"):
            return 200, json.dumps({"live": True, "ready": True}), H, url
        if url == RB.SALES + "/health":
            return 200, json.dumps({"ok": True, "release": o.get("sales_sha", SHA), "commercial_surface": "fail-closed"}), H, url
        if url.endswith("/api/release"):
            return 200, json.dumps({"deployment": {"commit_sha": o.get("central_sha", SHA)},
                                    "sales_mode": o.get("sales_mode", "globally-blocked")}), H, url
        if url.endswith("/api/sales/status"):
            return 200, json.dumps({"open": o.get("open", False), "requested": False, "blocked": None}), H, url
        if url.startswith(RB.PAGES):
            r = url.rstrip("/").split("/")[-1]
            return 200, (ROOT / f"pages-mirror/{r}.html").read_text("utf-8"), H, url
        if url.startswith(RB.APEX + "/api/checkout/"):
            return 404, '{"error":"checkout_via_sales_page_only"}', H, url
        if url.startswith(RB.APEX):
            return 308, "", {"location": url.replace(RB.APEX, RB.SALES)}, url
        if "/comprar/" in url:
            return 200, "<title>Vendas abrem em breve | ZEVANORY</title><h1>Vendas abrem em breve</h1>", H, url
        if "/hotmart/" in url:
            return 200, "<title>Vendas pausadas | ZEVANORY</title><h1>Vendas pausadas</h1>", H, url
        if url.endswith("/assinar/conteudo-pronto"):
            return 200, "<title>Assinaturas pausadas | ZEVANORY</title><h1>Assinaturas pausadas</h1>", H, url
        r = url.split("/")[-1]
        f = ROOT / f"sales-public/{r}.html"
        if not f.exists():
            return 404, (ROOT / "sales-public/404.html").read_text("utf-8"), H, url
        return 200, f.read_text("utf-8"), H, url


def run(fake):
    RB.fetch = fake
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "rb.json")
        old = sys.argv
        sys.argv = ["rb", "--expected-sha", SHA, "--out", out]
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc = RB.main()
        finally:
            sys.argv = old
        with open(out, encoding="utf-8") as fh:
            return rc, json.load(fh), buf.getvalue()


def failed(ev):
    return [c["check"] for c in ev["checks"] if not c["ok"]]


class ReadbackDryRunTest(unittest.TestCase):
    def test_closed_production_matching_sha_passes(self):
        fake = FakeProd()
        rc, ev, out = run(fake)
        self.assertEqual((rc, ev["verdict"], failed(ev)), (0, "PASS", []))
        self.assertEqual(ev["preserved_pendencies"], ["I4", "R9-D1", "R9-D2", "R9-D3", "R9-D4", "R9-D5", "R9-D6", "T1"])
        self.assertIn("PRESERVED_PENDENCIES=I4,R9-D1", out)
        self.assertTrue(all(m == "GET" for m, _, _ in fake.calls))

    def test_never_follows_redirects_on_purchase_routes(self):
        fake = FakeProd()
        run(fake)
        buy = [(u, f) for _, u, f in fake.calls if any(k in u for k in ("/comprar/", "/hotmart/", "/assinar/", "/api/checkout/"))]
        self.assertTrue(buy)
        self.assertTrue(all(f is False for _, f in buy), buy)

    def assertBlocked(self, fake, expect):
        rc, ev, out = run(fake)
        self.assertEqual(rc, 1)
        self.assertEqual(ev["homologation"], "BLOCKED_CONTAINMENT_REQUIRED")
        self.assertIn("HOMOLOGATION=BLOCKED", out)
        self.assertTrue(any(expect in c for c in failed(ev)), failed(ev))

    def test_sales_open_blocks(self):
        self.assertBlocked(FakeProd(open=True), "nogo:sales closed")

    def test_sales_mode_enabled_blocks(self):
        self.assertBlocked(FakeProd(sales_mode="enabled"), "nogo:sales closed")

    def test_own_checkout_form_blocks(self):
        url = RB.SALES + "/comprar/ZEV-CMB-011"
        page = '<h1>Comprar</h1><form method="post" action="/comprar/ZEV-CMB-011"><button>Pagar</button></form>'
        self.assertBlocked(FakeProd(**{url: (200, page, H, url)}), "nogo:own-checkout /comprar/ZEV-CMB-011")

    def test_checkout_api_answering_blocks(self):
        url = RB.APEX + "/api/checkout/mercadopago"
        self.assertBlocked(FakeProd(**{url: (200, '{"init_point":"https://www.mercadopago.com.br/x"}', H, url)}),
                           "nogo:/api/checkout/mercadopago")

    def test_hotmart_redirect_to_payment_blocks(self):
        url = RB.SALES + "/hotmart/combo-ia-vendas"
        self.assertBlocked(FakeProd(**{url: (302, "", {"location": "https://pay.hotmart.com/H1?off=x"}, url)}),
                           "nogo:hotmart/combo-ia-vendas")

    def test_subscription_redirect_blocks(self):
        url = RB.SALES + "/assinar/conteudo-pronto"
        self.assertBlocked(FakeProd(**{url: (302, "", {"location": "https://pay.hotmart.com/X1?off=y"}, url)}),
                           "nogo:P12 /assinar/conteudo-pronto")

    def test_payment_link_on_p12_page_blocks(self):
        url = RB.SALES + "/conteudo-pronto"
        html = (ROOT / "sales-public/conteudo-pronto.html").read_text("utf-8").replace(
            "</main>", '<a href="https://pay.hotmart.com/X107980075B?off=4ydutio7">Assinar</a></main>', 1)
        self.assertBlocked(FakeProd(**{url: (200, html, H, url)}), "nogo:P12/P15 conteudo-pronto")

    def test_wrong_sales_sha_blocks(self):
        self.assertBlocked(FakeProd(sales_sha="b" * 40), "sales-worker:release==expected")

    def test_wrong_central_sha_blocks(self):
        self.assertBlocked(FakeProd(central_sha="b" * 40), "central-worker:release==expected")

    def test_title_regression_blocks(self):
        url = RB.SALES + "/combo-ia-vendas"
        html = (ROOT / "sales-public/combo-ia-vendas.html").read_text("utf-8").replace(
            "Os dois treinamentos juntos", "Execução comercial com IA", 1)
        self.assertBlocked(FakeProd(**{url: (200, html, H, url)}), "combo-ia-vendas:title")


if __name__ == "__main__":
    unittest.main()
