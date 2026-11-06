#!/usr/bin/env python3
"""R148: base de conhecimento do chat do site, extraída das páginas OFICIAIS de produto (sales-public/<slug>.html).

O chat só repete texto que já está publicado na página do produto. Itens com preço, checkout, plataforma de pagamento,
WhatsApp ou link externo são descartados (as respostas sobre preço, entrega e reembolso têm fonte própria).
Uso:  python3 scripts/build_site_chat_knowledge.py          (grava data/site-chat-knowledge.json)
      python3 scripts/build_site_chat_knowledge.py --check  (falha se o arquivo estiver desatualizado)
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "site-chat-knowledge.json"
SLUGS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"]
# Perguntas genéricas da FAQ que já têm resposta oficial própria (entrega, arrependimento).
SKIP_FAQ = re.compile(r"como recebo|se n[aã]o for para mim", re.I)
BANNED = re.compile(r"R\$|hotmart|whats\s*-?\s*app|\bzap\b|https?://|www\.|desconto|promo|garanto|economia|\d+\s*%", re.I)


def text(fragment: str) -> str:
    t = html.unescape(re.sub(r"<[^>]+>", " ", fragment))
    return re.sub(r"\s+", " ", t).strip()


def section(page: str, heading: str) -> str:
    m = re.search(r"<h2[^>]*>\s*" + re.escape(heading) + r"\s*</h2>([\s\S]*?)(?=<h2[^>]*>|</main>)", page)
    return m.group(1) if m else ""


def list_after(page: str, heading: str) -> str:
    """Primeira <ul> logo depois do título (h3) da página oficial."""
    m = re.search(r"<h3[^>]*>\s*" + re.escape(heading) + r"\s*</h3>\s*(<ul[^>]*>[\s\S]*?</ul>)", page)
    return m.group(1) if m else ""


def items(fragment: str) -> list:
    return [text(x) for x in re.findall(r"<li[^>]*>([\s\S]*?)</li>", fragment)]


def clean(values):
    return [v for v in values if v and not BANNED.search(v)]


def build_one(slug: str) -> dict:
    page = (ROOT / "sales-public" / f"{slug}.html").read_text(encoding="utf-8")
    page = re.sub(r"<(script|style)[\s\S]*?</\1>", "", page)
    receive = clean(items(list_after(page, "O que você recebe")))
    audience = clean(items(list_after(page, "É para você se")))
    not_for = clean(items(list_after(page, "Não é para você se")))
    topics = []
    for title, desc in re.findall(r"<h3[^>]*>([\s\S]*?)</h3>\s*<p[^>]*>([\s\S]*?)</p>", section(page, "O que você encontra")):
        line = f"{text(title)}: {text(desc)}"
        if not BANNED.search(line):
            topics.append(line)
    faq = []
    for q, a in re.findall(r"<summary>([\s\S]*?)</summary>\s*<p>([\s\S]*?)</p>", section(page, "Perguntas antes de decidir")):
        q, a = text(q), text(a)
        if SKIP_FAQ.search(q) or BANNED.search(q) or BANNED.search(a):
            continue
        faq.append({"q": q, "a": a})
    restr = re.search(r"<dt>\s*Restrições\s*</dt>\s*<dd>([\s\S]*?)</dd>", page)
    license_text = text(restr.group(1)) if restr else ""
    if not receive or not audience:
        raise SystemExit(f"{slug}: seção obrigatória ausente na página oficial")
    return {"receive": receive, "audience": audience, "not_for": not_for, "topics": topics, "faq": faq,
            "license": "" if BANNED.search(license_text) else license_text}


def build() -> str:
    data = {"source": "sales-public/<slug>.html", "generator": "scripts/build_site_chat_knowledge.py",
            "products": {s: build_one(s) for s in SLUGS}}
    return json.dumps(data, ensure_ascii=False, indent=1) + "\n"


if __name__ == "__main__":
    out = build()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != out:
            print("data/site-chat-knowledge.json desatualizado: rode scripts/build_site_chat_knowledge.py", file=sys.stderr)
            sys.exit(1)
        print("site-chat-knowledge: OK")
    else:
        OUT.write_text(out, encoding="utf-8")
        print("gravado", OUT.relative_to(ROOT))
