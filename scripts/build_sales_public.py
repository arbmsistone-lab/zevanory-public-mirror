#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "sales-public"
OVERLAY = ROOT / "sales-overlay"
SALES_ORIGIN = "https://vendas.zevanory.api.br"
PRODUCTS = ("ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo")
LEGAL = ("termos", "privacidade", "reembolso", "afiliados")

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

def apply_approved_overlay() -> None:
    """Owner-approved sales-domain content (2026-10-02) applied over the sources.

    The sources stay the single editable truth for copy; this overlay carries the
    approved commercial/legal identity so a rebuild can never drop it again.
    """
    ov = json.loads((OVERLAY / "approved.json").read_text(encoding="utf-8"))
    for slug in HTML_ROUTES:
        path = OUT / f"{slug}.html"
        html = path.read_text(encoding="utf-8")
        head, sep, body = html.partition("</head>")
        # Canonical/social identity points to the domain that actually serves the page.
        head = head.replace("https://zevanory.api.br/", SALES_ORIGIN + "/")
        head = re.sub(r'("url":")https://zevanory\.api\.br/', r"\1" + SALES_ORIGIN + "/", head)
        if slug in LEGAL:
            if 'name="description"' not in head:
                head = head.replace("<title>", ov["head_meta"][slug] + "<title>", 1)
            if 'rel="canonical"' not in head:
                head = head.replace("<title>", f'<link rel="canonical" href="{SALES_ORIGIN}/{slug}"><title>', 1)
        html = head + sep + body
        # Structured data identity also points to the serving domain (approved).
        html = re.sub(
            r'(<script type="application/ld\+json">)(.*?)(</script>)',
            lambda m: m.group(1) + m.group(2).replace("https://zevanory.api.br", SALES_ORIGIN) + m.group(3),
            html, flags=re.S)
        if 'name="twitter:card"' not in html and 'property="og:title"' in html:
            def og(prop: str) -> str:
                mm = re.search(rf'<meta property="og:{prop}" content="([^"]*)">', html)
                return mm.group(1) if mm else ""
            tw = ('<meta name="twitter:card" content="summary_large_image">'
                  f'<meta name="twitter:title" content="{og("title")}">'
                  f'<meta name="twitter:description" content="{og("description")}">'
                  f'<meta name="twitter:image" content="{og("image")}">')
            html = html.replace("</head>", tw + "</head>", 1)
        if slug == "privacidade":
            html = re.sub(r"<strong>Pré-comercial\.</strong>[^<]*", ov["controller_notice"], html, count=1)
        if slug in PRODUCTS and "Condições comerciais" not in html:
            m = re.search(r'(<p class="section-kicker">Oferta responsável</p>.*?</section>)', html, re.S)
            if not m:
                raise SystemExit(f"offer anchor missing in {slug}")
            html = html[: m.end()] + ov["offers"][slug] + html[m.end():]
        if 'src="/whatsapp-contact.js"' not in html:
            html = html.replace("</body>", '<script src="/whatsapp-contact.js" defer></script></body>', 1)
        path.write_text(html, encoding="utf-8")
    for asset in ("legal.css", "robots.txt", "whatsapp-contact.js"):
        shutil.copy2(OVERLAY / asset, OUT / asset)

    controller = (OUT / "privacidade.html").read_text(encoding="utf-8")
    problems = []
    if "CNPJ 69.077.233/0001-99" not in controller or "Pré-comercial." in controller:
        problems.append("privacidade: controller identification missing")
    for slug in PRODUCTS:
        page = (OUT / f"{slug}.html").read_text(encoding="utf-8")
        if not re.search(r"Preço de tabela: R\$ \d+", page):
            problems.append(f"{slug}: approved price missing")
        if f'href="{SALES_ORIGIN}/{slug}"' not in page:
            problems.append(f"{slug}: canonical not on sales domain")
    if problems:
        raise SystemExit("approved sales overlay contract failed: " + "; ".join(problems))
    print("ZEVANORY_SALES_APPROVED_OVERLAY=PASS")

def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for slug in HTML_ROUTES:
        copy_text_page(slug)

    apply_approved_overlay()

    shutil.copy2(ROOT / "product.css", OUT / "product.css")
    shutil.copy2(ROOT / "sitemap.xml", OUT / "sitemap.xml")
    shutil.copytree(ROOT / "brand", OUT / "brand")
    # Approved social/creative brand assets live in the overlay (2026-10-02).
    shutil.copytree(OVERLAY / "brand", OUT / "brand", dirs_exist_ok=True)

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
