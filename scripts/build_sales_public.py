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
    "material-gratuito",
    "checklist-15-minutos",
    "solucoes",
    "quem-criou",
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


LEGAL_FOOTER = ('<div class="container footer-legal">'
                'A. RENAN ALVES MOREIRA BITU LTDA · CNPJ 69.077.233/0001-99 · Rua Francisco de Freitas Neto, 96, Casa Residencial, Alto do Tenente, '
                'Várzea Alegre/CE, CEP 63540-000 · <a href="mailto:suporte@zevanory.api.br">suporte@zevanory.api.br</a> · '
                'WhatsApp <a href="https://wa.me/5588992545413">+55 88 99254-5413</a></div>')

COMMERCE = {
    "ia-na-pratica": {"sku": "ZEV-IA-011", "name": "IA na Prática", "price": 197,
        "items": ["Manual completo (PDF e DOCX editável)", "Guia rápido em PDF", "Arquivo de comandos prontos para IA", "Planilha de aplicação (XLSX)", "Arquivo 'Comece aqui' com o passo a passo"],
        "faq_q": None},
    "vendas-na-pratica": {"sku": "ZEV-VEN-011", "name": "Vendas na Prática", "price": 197,
        "items": ["Manual completo (PDF e DOCX editável)", "Guia rápido em PDF", "Modelos de mensagens de venda e follow-up", "Roteiro de conteúdos", "Planilha de acompanhamento comercial (XLSX)", "Arquivo 'Comece aqui' com o passo a passo"],
        "faq_q": None},
    "lucro-e-caixa": {"sku": "ZEV-LCX-011", "name": "Lucro & Caixa", "price": 247,
        "items": ["Manual completo (PDF e DOCX editável)", "Guia rápido (PDF e DOCX)", "Planilha de caixa e margem (XLSX)", "Checklist financeiro semanal", "Comandos de IA para análise financeira", "Arquivo 'Comece aqui' com o passo a passo"],
        "faq_q": None},
    "combo-ia-vendas": {"sku": "ZEV-CMB-011", "name": "Combo IA + Vendas", "price": 297,
        "items": ["IA na Prática completo (manual, guia, comandos e planilha)", "Vendas na Prática completo (manual, guia, mensagens, conteúdos e planilha)", "Economia de R$ 97 em relação à compra separada (R$ 394)"],
        "faq_q": ("Preciso comprar os produtos separadamente?", "Não. O Combo já inclui o IA na Prática e o Vendas na Prática completos, por R$ 297 (separados custariam R$ 394).")},
    "negocio-completo": {"sku": "ZEV-NGC-011", "name": "Negócio Completo", "price": 397,
        "items": ["IA na Prática completo", "Vendas na Prática completo", "Lucro & Caixa completo", "Plano integrado de 30 dias (PDF e DOCX)", "Painel de decisão integrada (XLSX)", "Economia de R$ 244 em relação à compra separada (R$ 641)"],
        "faq_q": ("Inclui os três produtos separados?", "Sim. Inclui IA na Prática, Vendas na Prática e Lucro & Caixa completos, mais o Plano integrado de 30 dias e o Painel de decisão integrada.")},
}
DELIVERY_Q = ("Como recebo o produto?", "Logo após a confirmação do pagamento (Pix ou cartão via Mercado Pago), você recebe por e-mail um link pessoal para baixar o arquivo .zip com todo o material. Se o link se perder, peça outro em zevanory.api.br/entrega/reenviar.")
GUARANTEE_Q = ("E se não for para mim?", "Você tem 7 dias de garantia: peça o reembolso integral em zevanory.api.br/pedir-reembolso, sem precisar explicar o motivo.")

def _faq_html(q, a):
    return f"<details><summary>{q}</summary><p>{a}</p></details>"

def apply_commerce(slug: str, html: str) -> str:
    c = COMMERCE[slug]
    buy = f"/comprar/{c['sku']}"
    label = f"Comprar agora · R$ {c['price']}"
    html = re.sub(r'<a class="nav-cta" href="mailto:[^"]*">', '<a class="nav-cta" href="https://wa.me/5588992545413">', html)
    # Every primary CTA buys.
    html = re.sub(r'<a class="button primary" href="mailto:[^"]*">[^<]*</a>', f'<a class="button primary" href="{buy}" rel="nofollow">{label}</a>', html)
    html = re.sub(r'<p class="microcopy">[^<]*</p>', '<p class="microcopy">Pagamento seguro pelo Mercado Pago (Pix ou cartão) · download logo após a confirmação · garantia de 7 dias.</p>', html)
    trust = {
        ("Performance primeiro", "HTML semântico e zero dependência de JS para renderizar."): ("Download imediato", "Link por e-mail logo após a confirmação do pagamento."),
        ("Gate antes da venda", "Checkout só após validação completa."): ("Garantia de 7 dias", "Não gostou? Reembolso integral, sem burocracia."),
        ("Transparência comercial", "Escopo e limites antes da contratação."): ("Pagamento seguro", "Pix ou cartão pelo Mercado Pago."),
    }
    for (old_t, old_s), (new_t, new_s) in trust.items():
        html = html.replace(f"<strong>{old_t}</strong><span>{old_s}</span>", f"<strong>{new_t}</strong><span>{new_s}</span>")
    items = "".join(f"<li>{i}</li>" for i in c["items"])
    aside = (f'<aside class="offer-side"><div><span class="status-pill">R$ {c["price"]} · pagamento único</span>'
             f'<h3>O que você recebe</h3><ul>{items}</ul>'
             '<p>Entrega por download (.zip) no seu e-mail, logo após a confirmação do pagamento. Garantia de 7 dias.</p></div>'
             f'<a class="button primary" href="{buy}" rel="nofollow">{label}</a></aside>')
    html = re.sub(r'<aside class="offer-side">.*?</aside>', aside, html, count=1, flags=re.S)
    # FAQ: drop "when will sales open" and fix composition answers; add delivery + guarantee.
    html = re.sub(r'<details><summary>Quando (a compra|o checkout) será liberad[ao]\?</summary><p>[^<]*</p></details>', _faq_html(*DELIVERY_Q) + _faq_html(*GUARANTEE_Q), html)
    if c["faq_q"]:
        q, a = c["faq_q"]
        html = re.sub(rf'(<summary>{re.escape(q)}</summary><p>)[^<]*(</p>)', rf'\g<1>{a}\g<2>', html)
    # Structured data: price offer + matching FAQ.
    def fix_ld(m):
        import json as _json
        data = _json.loads(m.group(2))
        for node in data.get("@graph", []):
            if node.get("@type") == "Product":
                node["offers"] = {"@type": "Offer", "price": f"{c['price']}.00", "priceCurrency": "BRL", "availability": "https://schema.org/InStock",
                                  "url": f"{SALES_ORIGIN}/{slug}", "seller": {"@type": "Organization", "name": "A. RENAN ALVES MOREIRA BITU LTDA"}}
            if node.get("@type") == "FAQPage":
                kept = [q for q in node.get("mainEntity", []) if "liberad" not in q.get("name", "")]
                if c["faq_q"]:
                    for q in kept:
                        if q.get("name") == c["faq_q"][0]:
                            q["acceptedAnswer"]["text"] = c["faq_q"][1]
                for qq, aa in (DELIVERY_Q, GUARANTEE_Q):
                    kept.append({"@type": "Question", "name": qq, "acceptedAnswer": {"@type": "Answer", "text": aa}})
                node["mainEntity"] = kept
        return m.group(1) + _json.dumps(data, ensure_ascii=False) + m.group(3)
    html = re.sub(r'(<script type="application/ld\+json">)(.*?)(</script>)', fix_ld, html, count=1, flags=re.S)
    return html

def apply_catalog(html: str) -> str:
    html = html.replace("com escopo explícito e venda condicionada a gates reais.", "com escopo explícito, pagamento seguro e garantia de 7 dias.")
    for slug, c in COMMERCE.items():
        html = re.sub(rf'(<a class="catalog-card" href="/{slug}">.*?<p>[^<]*</p>)', rf'\g<1><span class="catalog-type">R$ {c["price"]} · download imediato</span>', html, count=1, flags=re.S)
    for slug in ("zevanory-sales", "zevanory-cfo", "arbm-contador-saloes"):
        html = re.sub(rf'(<a class="catalog-card" href="/{slug}">.*?<p>[^<]*</p>)', r'\g<1><span class="catalog-type">Em breve</span>', html, count=1, flags=re.S)
    return html

def add_legal_footer(html: str) -> str:
    if "footer-legal" in html:
        return html
    # Inside <main>: the product layout keeps a compact fixed footer, the identification scrolls with the page.
    if "</main>" in html:
        return html.replace("</main>", LEGAL_FOOTER + "</main>", 1)
    return html.replace("</body>", LEGAL_FOOTER + "</body>", 1)

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
        if slug in PRODUCTS:
            html = apply_commerce(slug, html)
        if slug == "solucoes":
            html = apply_catalog(html)
        html = add_legal_footer(html).replace("contato@zevanory.api.br", "suporte@zevanory.api.br")
        # Source pages may list both addresses ("contato@ ou suporte@"); after the public
        # canonicalization they would read "suporte@ ou suporte@". Collapse the duplicate.
        html = re.sub(r"suporte@zevanory\.api\.br( ou | or |, | e )suporte@zevanory\.api\.br", "suporte@zevanory.api.br", html)
        if 'src="/whatsapp-contact.js"' not in html:
            html = html.replace("</body>", '<script src="/whatsapp-contact.js" defer></script></body>', 1)
        path.write_text(html, encoding="utf-8")
    shutil.copy2(ROOT / "legal.css", OUT / "legal.css")
    for asset in ("robots.txt", "whatsapp-contact.js"):
        shutil.copy2(OVERLAY / asset, OUT / asset)

    controller = (OUT / "privacidade.html").read_text(encoding="utf-8")
    problems = []
    if "CNPJ 69.077.233/0001-99" not in controller or "Pré-comercial." in controller:
        problems.append("privacidade: controller identification missing")
    # CSP is style-src 'self' / script-src 'self': inline styles or scripts break the live smoke.
    for html_file in sorted(OUT.glob("*.html")):
        text = html_file.read_text(encoding="utf-8")
        if re.search(r'\sstyle="', text) or "<style" in text:
            problems.append(f"{html_file.name}: inline style blocked by CSP")
        if re.search(r"<script(?![^>]*\bsrc=)(?![^>]*application/ld\+json)[^>]*>", text):
            problems.append(f"{html_file.name}: inline script blocked by CSP")
    for slug in PRODUCTS:
        page = (OUT / f"{slug}.html").read_text(encoding="utf-8")
        if not re.search(r"Preço de tabela: R\$ \d+", page):
            problems.append(f"{slug}: approved price missing")
        if f'href="{SALES_ORIGIN}/{slug}"' not in page:
            problems.append(f"{slug}: canonical not on sales domain")
        if f'href="/comprar/{COMMERCE[slug]["sku"]}"' not in page:
            problems.append(f"{slug}: buy button missing")
        for banned in ("gates oficiais", "Gate antes da venda", "será liberad", "pagamento reconciliado", "mailto:contato@"):
            if banned in page:
                problems.append(f"{slug}: banned pre-sale copy '{banned}'")
        if "CNPJ 69.077.233/0001-99" not in page:
            problems.append(f"{slug}: supplier identification missing")
        if '"offers"' not in page:
            problems.append(f"{slug}: structured offer missing")
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
    # Sales sitemap must match the canonical vendas domain, not the apex blog.
    # Keep the apex sitemap as-is for editorial articles.
    sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    sitemap = re.sub(r"\s*<url><loc>https://zevanory\.api\.br/</loc>.*?</url>", "", sitemap, count=1, flags=re.S)
    sitemap = re.sub(r"\s*<url><loc>https://zevanory\.api\.br/blog/[^<]+</loc>.*?</url>", "", sitemap, flags=re.S)
    sitemap = sitemap.replace("<loc>https://zevanory.api.br/", "<loc>https://vendas.zevanory.api.br/")
    (OUT / "sitemap.xml").write_text(sitemap, encoding="utf-8")
    shutil.copytree(ROOT / "brand", OUT / "brand")
    (OUT / "assets").mkdir(exist_ok=True)
    portrait = ROOT / "assets" / "renan-bitu.webp"
    if not portrait.is_file() or portrait.stat().st_size != 16232:
        raise SystemExit("founder portrait missing or unexpected size")
    shutil.copy2(portrait, OUT / "assets" / "renan-bitu.webp")
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
