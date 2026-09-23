#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://zevanory.api.br"
PRODUCTS = [
    ("zevanory-one/index.html", "zevanory-one", "SoftwareApplication"),
    ("arbm-contador-saloes/index.html", "arbm-contador-saloes", "SoftwareApplication"),
    ("arbm-sist/index.html", "arbm-sist", "SoftwareApplication"),
    ("ia-na-pratica/index.html", "ia-na-pratica", "Product"),
    ("vendas-na-pratica/index.html", "vendas-na-pratica", "Product"),
    ("lucro-e-caixa/index.html", "lucro-e-caixa", "Product"),
    ("combo-ia-vendas/index.html", "combo-ia-vendas", "Product"),
    ("negocio-completo/index.html", "negocio-completo", "Product"),
]
CHECKOUT_RE = re.compile(r"(checkout|comprar|buy|payment|pagamento|mercadopago|stripe|hotmart|kiwify)", re.I)

class Doc(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.in_title = False
        self.h1 = 0
        self.meta = {}
        self.og = {}
        self.canonical = None
        self.links = []
        self.scripts = []
        self.json_ld = []
        self.capture_ld = False
        self.ld_buf = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self.in_title = True
        elif tag == "h1":
            self.h1 += 1
        elif tag == "meta":
            if a.get("name"):
                self.meta[a["name"].lower()] = a.get("content", "")
            if a.get("property"):
                self.og[a["property"].lower()] = a.get("content", "")
        elif tag == "link":
            if "canonical" in a.get("rel", "").lower().split():
                self.canonical = a.get("href")
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "script":
            typ = a.get("type", "").lower()
            src = a.get("src", "")
            if src:
                self.scripts.append(src)
            if typ == "application/ld+json":
                self.capture_ld = True
                self.ld_buf = []

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag == "script" and self.capture_ld:
            self.json_ld.append("".join(self.ld_buf).strip())
            self.capture_ld = False
            self.ld_buf = []

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.capture_ld:
            self.ld_buf.append(data)

def fail(msg):
    print(f"FAIL: {msg}")
    return 1

def pass_(msg):
    print(f"PASS: {msg}")

def schema_types(blocks):
    found = set()
    faq_count = 0
    for raw in blocks:
        obj = json.loads(raw)
        stack = [obj]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                typ = node.get("@type")
                if isinstance(typ, str):
                    found.add(typ)
                    if typ == "FAQPage" and isinstance(node.get("mainEntity"), list):
                        faq_count += len(node["mainEntity"])
                graph = node.get("@graph")
                if isinstance(graph, list):
                    stack.extend(graph)
            elif isinstance(node, list):
                stack.extend(node)
    return found, faq_count

def check_page(path, slug, expected_schema):
    errors = 0
    fp = ROOT / path
    if not fp.exists():
        return fail(f"{path}: arquivo ausente")

    text = fp.read_text(encoding="utf-8")
    doc = Doc()
    doc.feed(text)

    if not doc.title.strip():
        errors += fail(f"{path}: title ausente")
    if not doc.meta.get("description"):
        errors += fail(f"{path}: description ausente")
    robots = doc.meta.get("robots", "")
    if "index" not in robots or "follow" not in robots:
        errors += fail(f"{path}: robots deve conter index,follow")
    expected_canonical = f"{BASE}/{slug}"
    if (doc.canonical or "").rstrip("/") != expected_canonical:
        errors += fail(f"{path}: canonical divergente: {doc.canonical!r}")
    if doc.h1 != 1:
        errors += fail(f"{path}: esperado exatamente 1 h1, encontrado {doc.h1}")

    for prop in ("og:type", "og:title", "og:description", "og:url", "og:image"):
        if not doc.og.get(prop):
            errors += fail(f"{path}: {prop} ausente")

    for name in ("twitter:card", "twitter:title", "twitter:description", "twitter:image"):
        if not doc.meta.get(name):
            errors += fail(f"{path}: {name} ausente")

    if doc.scripts:
        errors += fail(f"{path}: JS externo/cliente proibido no primeiro render: {doc.scripts}")

    try:
        types, faq_count = schema_types(doc.json_ld)
    except Exception as exc:
        errors += fail(f"{path}: JSON-LD inválido: {exc}")
        types, faq_count = set(), 0

    if expected_schema not in types:
        errors += fail(f"{path}: schema {expected_schema} ausente; encontrados {sorted(types)}")
    if "FAQPage" not in types or faq_count < 2:
        errors += fail(f"{path}: FAQPage insuficiente ({faq_count} perguntas)")

    checkout_links = [href for href in doc.links if CHECKOUT_RE.search(href)]
    if checkout_links:
        errors += fail(f"{path}: VENDA OFF, checkout detectado: {checkout_links}")

    if errors == 0:
        pass_(f"{path}: estrutura, SEO, FAQ e fail-closed aprovados")
    return errors

def check_solutions():
    path = ROOT / "solucoes/index.html"
    if not path.exists():
        return fail("solucoes/index.html ausente")
    text = path.read_text(encoding="utf-8")
    doc = Doc()
    doc.feed(text)
    errors = 0
    if doc.h1 != 1:
        errors += fail(f"solucoes: esperado 1 h1, encontrado {doc.h1}")
    if not doc.meta.get("description") or not doc.canonical:
        errors += fail("solucoes: metadata essencial ausente")
    for slug in [x[1] for x in PRODUCTS]:
        if not any(slug in href for href in doc.links):
            errors += fail(f"solucoes: link para {slug} ausente")
    if errors == 0:
        pass_(f"solucoes/index.html: catálogo {len(PRODUCTS)}/{len(PRODUCTS)} aprovado")
    return errors

def check_css():
    css = (ROOT / "product.css").read_text(encoding="utf-8")
    errors = 0
    for token in ("prefers-reduced-motion", "content-visibility", ":focus", "@media"):
        if token not in css:
            errors += fail(f"product.css: requisito ausente: {token}")
    if "javascript:" in css.lower():
        errors += fail("product.css: conteúdo inválido")
    if errors == 0:
        pass_("product.css: performance/a11y estrutural aprovada")
    return errors

def check_sitemap():
    text = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    errors = 0
    for _, slug, _ in PRODUCTS:
        url = f"{BASE}/{slug}"
        if url not in text:
            errors += fail(f"sitemap: {url} ausente")
    if f"{BASE}/solucoes" not in text:
        errors += fail("sitemap: /solucoes ausente")
    if errors == 0:
        pass_(f"sitemap.xml: {len(PRODUCTS)} produtos + soluções presentes")
    return errors


def check_official_whatsapp():
    worker_path = ROOT / "worker" / "cloudflare-worker.recovered.mjs"
    deploy_path = ROOT / ".github" / "workflows" / "central-production-deploy.yml"
    if not worker_path.exists() or not deploy_path.exists():
        return fail("WhatsApp oficial: fontes canônicas ausentes")

    worker = worker_path.read_text(encoding="utf-8")
    deploy = deploy_path.read_text(encoding="utf-8")
    errors = 0

    for token in ("+55 88 9234-0423", "558892340423"):
        if token in worker:
            errors += fail(f"WhatsApp oficial: referência legada presente no worker: {token}")

    for marker in (
        'display: "+55 88 99254-5413"',
        'e164: "5588992545413"',
        'url: "https://wa.me/5588992545413"',
        "whatsapp: OFFICIAL_WHATSAPP.display",
        "whatsappUrl: whatsappLink(source)",
    ):
        if marker not in worker:
            errors += fail(f"WhatsApp oficial: marcador canônico ausente no worker: {marker}")

    for front in (
        "instagram", "facebook", "tiktok", "youtube", "linkedin", "google",
        "whatsapp", "email", "affiliate", "nuvemshop", "mercado_livre", "zevanory",
    ):
        if f"{front}: profile(" not in worker:
            errors += fail(f"WhatsApp oficial: frente comercial não herdando perfil canônico: {front}")

    for marker in (
        'c["vars"]["ZEVANORY_WHATSAPP_E164"]="+5588992545413"',
        'c["vars"]["ZEVANORY_WHATSAPP_DISPLAY"]="+55 88 99254-5413"',
        'c["vars"]["ZEVANORY_WHATSAPP_COUNTRY"]="BR"',
        '"+55 88 9234-0423": "+55 88 99254-5413"',
        '"558892340423": "5588992545413"',
    ):
        if marker not in deploy:
            errors += fail(f"WhatsApp oficial: marcador de cutover ausente no deploy: {marker}")

    if 'c["vars"]["WHATSAPP_SALES_ENABLED"]="false"' not in deploy:
        errors += fail("WhatsApp oficial: fail-closed WHATSAPP_SALES_ENABLED=false ausente")

    if errors == 0:
        pass_("WhatsApp oficial: novo número propagado a 12 frentes e legado bloqueado")
    return errors

def main():
    errors = 0
    for item in PRODUCTS:
        errors += check_page(*item)
    errors += check_solutions()
    errors += check_css()
    errors += check_sitemap()
    errors += check_official_whatsapp()

    if errors:
        print(f"\nPRE-MERGE GATE: FAIL ({errors} erro(s))")
        return 2

    print("\nPRE-MERGE GATE: PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
