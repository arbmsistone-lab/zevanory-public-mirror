"""Regression: inspect sitemap PRODUCED by the canonical sales build, not the template."""
import pathlib
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "sales-public/sitemap.xml"

class GeneratedSalesSitemapTest(unittest.TestCase):
    def test_generated_sitemap_only_contains_canonical_sales_locations(self):
        run = subprocess.run([sys.executable, str(ROOT / "scripts/build_sales_public.py")],
                             cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr[-1800:] + run.stdout[-1800:])
        self.assertTrue(OUTPUT.is_file())
        tree = ET.parse(OUTPUT)
        locs = [el.text for el in tree.iter() if el.tag.endswith("}loc") or el.tag == "loc"]
        self.assertGreaterEqual(len(locs), 6)
        self.assertEqual(len(locs), len(set(locs)), "duplicate URL in generated sitemap")
        self.assertTrue(all(urlsplit(loc).netloc == "vendas.zevanory.api.br" for loc in locs), locs)
        self.assertFalse(any("/blog/" in urlsplit(loc).path for loc in locs), locs)
        for slug in ("ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa",
                     "combo-ia-vendas", "negocio-completo", "quem-criou"):
            self.assertTrue(any(urlsplit(loc).path.rstrip("/") == "/" + slug for loc in locs), slug)

if __name__ == "__main__":
    unittest.main()
