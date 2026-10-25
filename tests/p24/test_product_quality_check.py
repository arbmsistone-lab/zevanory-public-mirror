#!/usr/bin/env python3
"""Testes negativos e de controle do gate P24 (scripts/p24/product_quality_check.py). Sem rede, sem zips."""
from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("p24check", ROOT / "scripts/p24/product_quality_check.py")
p24 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(p24)  # type: ignore[union-attr]

SLUGS = ("ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo")
FILES = [f"sales-public/{s}.html" for s in SLUGS] + [
    "data/p24/promise-map.json", "data/p24/delivery-manifest.json", "data/p24/rubric.json", "data/p24/open-defects.json",
    "data/products.json", "worker/cloudflare-worker.recovered.mjs",
]


class P24CheckTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = Path(self._td.name)
        for rel in FILES:
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, self.root / rel)

    def tearDown(self):
        self._td.cleanup()

    def jload(self, rel):
        return json.loads((self.root / rel).read_text(encoding="utf-8"))

    def jsave(self, rel, obj):
        (self.root / rel).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")

    def edit(self, rel, old, new):
        p = self.root / rel
        s = p.read_text(encoding="utf-8")
        self.assertIn(old, s)
        p.write_text(s.replace(old, new, 1), encoding="utf-8")

    def entry(self, man, slug, path):
        return next(e for e in man["products"][slug]["entries"] if e["path"] == path)

    def assertFailsWith(self, needle):
        rep = p24.evaluate(self.root)
        self.assertEqual(rep["gate"], "FAIL")
        self.assertTrue(any(needle in e for e in rep["errors"]), f"esperado {needle!r}; obtido {rep['errors'][:5]}")

    def test_real_inputs_gate_pass_verdict_fail(self):
        rep = p24.evaluate(self.root)
        self.assertEqual(rep["errors"], [])
        self.assertEqual(rep["gate"], "PASS")
        self.assertEqual(rep["p24_verdict"], "FAIL")
        self.assertEqual(rep["totals"]["promises_without_declared_delivery"], 0)
        self.assertGreater(rep["totals"]["open_defects_pi"], 0)
        self.assertEqual(rep["totals"]["promises_pending_human_review"], 0)

    def test_new_page_promise_without_delivery_fails(self):
        self.edit("sales-public/ia-na-pratica.html", "<li>Guia rápido em PDF</li><li>Arquivo de comandos",
                  "<li>Guia rápido em PDF</li><li>Videoaulas exclusivas</li><li>Arquivo de comandos")
        self.assertFailsWith("PROMESSA SEM ENTREGA DECLARADA: 'Videoaulas exclusivas'")

    def test_new_scope_card_without_delivery_fails(self):
        self.edit("sales-public/lucro-e-caixa.html", "<h3>Fixos e variáveis</h3>", "<h3>Planejamento tributário</h3>")
        self.assertFailsWith("PROMESSA SEM ENTREGA DECLARADA: 'Planejamento tributário'")

    def test_stale_map_entry_fails(self):
        m = self.jload("data/p24/promise-map.json")
        m["products"]["ia-na-pratica"]["promises"].append({"id": "IA-X99", "text": "Bônus que a página não promete", "type": "deliverable", "files": ["00_COMECE_AQUI.txt"]})
        self.jsave("data/p24/promise-map.json", m)
        self.assertFailsWith("mapa desatualizado")

    def test_promised_file_missing_from_zip_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        man["products"]["vendas-na-pratica"]["entries"] = [e for e in man["products"]["vendas-na-pratica"]["entries"] if e["path"] != "ZEVANORY_Vendas_Mensagens.txt"]
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("arquivo prometido ausente do zip: ZEVANORY_Vendas_Mensagens.txt")

    def test_file_that_does_not_open_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        self.entry(man, "lucro-e-caixa", "ZEVANORY_Lucro_e_Caixa_Planilha_v1.1.xlsx")["open"]["ok"] = False
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("arquivo não abre")

    def test_zip_sha_differs_from_worker_catalog_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        man["products"]["combo-ia-vendas"]["artifact_sha256"] = "0" * 64
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("difere do catálogo do Worker")

    def test_bundle_component_not_identical_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        self.entry(man, "negocio-completo", "03_Lucro_e_Caixa/ZEVANORY_Lucro_e_Caixa_Planilha_v1.1.xlsx")["sha256"] = "f" * 64
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("arquivos diferentes do produto avulso")

    def test_bundle_economy_arithmetic_fails(self):
        old = "Economia de R$ 97 em relação à compra separada (R$ 394)"
        new = "Economia de R$ 120 em relação à compra separada (R$ 394)"
        page = self.root / "sales-public/combo-ia-vendas.html"
        page.write_text(page.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")
        m = self.jload("data/p24/promise-map.json")
        for p in m["products"]["combo-ia-vendas"]["promises"]:
            if p["text"] == old:
                p["text"] = new
        self.jsave("data/p24/promise-map.json", m)
        self.assertFailsWith("conta não fecha")

    def test_promised_format_not_delivered_fails(self):
        m = self.jload("data/p24/promise-map.json")
        m["products"]["ia-na-pratica"]["promises"][0]["files"] = ["ZEVANORY_IA_Manual_v1.1.pdf"]
        self.jsave("data/p24/promise-map.json", m)
        self.assertFailsWith("a promessa cita DOCX")

    def test_missing_anchor_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        self.entry(man, "ia-na-pratica", "ZEVANORY_IA_Manual_v1.1.pdf")["anchors"]["briefing"] = 0
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("âncora 'briefing' ausente")

    def test_unregistered_new_defect_fails(self):
        d = self.jload("data/p24/open-defects.json")
        d["defects"] = d["defects"][1:]
        self.jsave("data/p24/open-defects.json", d)
        self.assertFailsWith("DEFEITO PI NOVO")

    def test_stale_registered_defect_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        self.entry(man, "lucro-e-caixa", "ZEVANORY_Lucro_e_Caixa_Manual_v1.1.pdf")["open"]["lang"] = "pt-BR"
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("não ocorre mais")

    def test_untagged_pdf_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        self.entry(man, "lucro-e-caixa", "ZEVANORY_Lucro_e_Caixa_Manual_v1.1.pdf")["open"]["tagged"] = False
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("DEFEITO PI NOVO (pdf_sem_marcacao)")

    def test_spreadsheet_formula_error_fails(self):
        man = self.jload("data/p24/delivery-manifest.json")
        self.entry(man, "ia-na-pratica", "ZEVANORY_IA_Planilha.xlsx")["open"]["recalc"] = {"status": "FAIL", "errors": 3}
        self.jsave("data/p24/delivery-manifest.json", man)
        self.assertFailsWith("erro(s) de fórmula no recálculo")

    def test_sold_product_without_map_fails(self):
        m = self.jload("data/p24/promise-map.json")
        del m["products"]["negocio-completo"]
        self.jsave("data/p24/promise-map.json", m)
        self.assertFailsWith("negocio-completo: produto vendido sem mapa de promessas P24")

    def test_human_review_without_finding_fails(self):
        m = self.jload("data/p24/promise-map.json")
        m["products"]["vendas-na-pratica"]["promises"][0]["review"] = "REVISAO_HUMANA"
        self.jsave("data/p24/promise-map.json", m)
        self.assertFailsWith("revisão humana sem descrição")

    def test_page_markup_change_fails_closed(self):
        self.edit("sales-public/combo-ia-vendas.html", '<div class="hero-panel receipt">', '<div class="hero-panel recibo">')
        self.assertFailsWith("região de promessas 'hero_receipt' não encontrada")

    def test_reintroduced_prospecting_card_fails(self):
        self.edit("sales-public/vendas-na-pratica.html", "<h3>Uma oferta que você consegue cumprir</h3>", "<h3>Quem abordar</h3>")
        self.assertFailsWith("PROMESSA SEM ENTREGA DECLARADA: 'Quem abordar'")


if __name__ == "__main__":
    unittest.main(verbosity=2)
