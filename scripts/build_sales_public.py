#!/usr/bin/env python3
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "sales-public"

HTML_ROUTES = (
    "solucoes",
    "zevanory-sales",
    "arbm-contador-saloes",
    "ia-na-pratica",
    "vendas-na-pratica",
    "lucro-e-caixa",
    "combo-ia-vendas",
    "negocio-completo",
    "zevanory-cfo",
    "termos",
    "privacidade",
    "reembolso",
    "afiliados",
)

def copy_text_page(slug: str) -> None:
    source = ROOT / slug / "index.html"
    if not source.exists():
        raise SystemExit(f"missing sales page: {source.relative_to(ROOT)}")
    text = source.read_text(encoding="utf-8")
    text = text.replace("/zevanory-public-mirror/", "/")
    (OUT / f"{slug}.html").write_text(text, encoding="utf-8")

def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for slug in HTML_ROUTES:
        copy_text_page(slug)

    shutil.copy2(ROOT / "product.css", OUT / "product.css")
    shutil.copy2(ROOT / "sitemap.xml", OUT / "sitemap.xml")
    shutil.copytree(ROOT / "brand", OUT / "brand")

    # Root is the solutions catalog. Keep a physical index for workers.dev previews
    # even though the worker also rewrites / to /solucoes.html.
    shutil.copy2(OUT / "solucoes.html", OUT / "index.html")

    sales = (OUT / "zevanory-sales.html").read_text(encoding="utf-8")
    required = (
        "<title>ZEVANORY SALES",
        'href="/product.css"',
        'href="/solucoes"',
        "Autonomous Sales Platform",
        "SALES ASSIST",
        "SALES AUTOPILOT",
        "SALES AUTONOMOUS",
    )
    missing = [token for token in required if token not in sales]
    if missing:
        raise SystemExit(f"sales build contract missing: {missing}")
    if "/zevanory-public-mirror/" in sales:
        raise SystemExit("sales build still contains mirror path prefix")

    built = sorted(p.name for p in OUT.glob("*.html"))
    print("ZEVANORY_SALES_PUBLIC_BUILD=PASS")
    print("HTML_ASSETS=" + ",".join(built))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
