#!/usr/bin/env python3
"""ZEVANORY | Promessa de venda = material entregue (auditoria P24, Sol 244.07/244.13).

A conferência P24 (PR #926) achou duas promessas que o material entregue não sustenta:
  1. Vendas na Prática vendido como "prospecção" / "Quem abordar": o manual organiza os pedidos e
     oportunidades que chegam (atendimento, oferta, follow-up); "prospec" aparece 0 vezes no material.
  2. Combo IA + Vendas vendido como "IA dentro do processo comercial / do fluxo": o 00_LEIA_PRIMEIRO.txt
     do combo diz que os dois treinamentos funcionam de forma independente.
O Negócio Completo herda o item 1 onde descreve a parte de vendas.

Este gate falha se QUALQUER fonte voltada ao cliente voltar a atribuir prospecção / "quem abordar" a
Vendas na Prática, Combo IA + Vendas ou Negócio Completo, ou afirmar IA integrada ao fluxo de vendas no
Combo. Fontes: páginas centrais e páginas de venda geradas (título, meta, og/twitter, JSON-LD e corpo),
catálogos e kit de afiliado (por cartão/linha do produto), llms.txt, gerador das páginas de venda e o
conhecimento do Worker usado para responder clientes (suporte, chat do site, blog, WhatsApp/voz).
O ZEVANORY SALES (produto futuro) pode falar em prospecção, mas só rotulado como "Em breve".

Uso:  python3 scripts/ci/sales_promise_consistency.py              (verifica o repositório)
      python3 scripts/ci/sales_promise_consistency.py --self-test  (prova que o texto antigo reprova)
"""
from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCTS = ("vendas-na-pratica", "combo-ia-vendas", "negocio-completo")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.lower())


# Prospecção / "quem abordar" atribuídos a Vendas, Combo ou Negócio Completo.
PROSPECT = re.compile(r"prospec|quem abordar")
# IA integrada ao fluxo/processo de vendas (Combo).
INTEGRATED = re.compile(
    r"ia dentro d[oa]"
    r"|dentro d[oa] (processo|fluxo) comercia"
    r"|integrad\w* ao (fluxo|processo) comercia"
    r"|conect\w* (a )?ia (ao|a|as) (processo|etapa|fluxo)"
    r"|combo conecta"
    r"|ia (e vendas )?trabalhando juntas"
    r"|ia aplicada (ao processo comercial|onde o processo)"
    r"|ia para vender mais"
    r"|execucao comercial com ia"
    r"|aplicar ia dentro"
)

# Páginas inteiras de um único produto (central + gerada).
PRODUCT_PAGES = {
    "vendas-na-pratica": ["vendas-na-pratica/index.html", "sales-public/vendas-na-pratica.html"],
    "combo-ia-vendas": ["combo-ia-vendas/index.html", "sales-public/combo-ia-vendas.html"],
    "negocio-completo": ["negocio-completo/index.html", "sales-public/negocio-completo.html"],
}
# Páginas com vários produtos: verifica só o cartão/linha que leva ao produto.
CATALOG_PAGES = [
    "index.html", "solucoes/index.html", "kit-afiliado/index.html",
    "sales-public/index.html", "sales-public/solucoes.html", "sales-public/kit-afiliado.html",
]
LLMS = ["sales-overlay/llms.txt", "sales-public/llms.txt"]
SOON_PAGES = ["zevanory-sales/index.html", "sales-public/zevanory-sales.html"]
GENERATOR = "scripts/build_sales_public.py"
WORKER_SUPPORT = "worker/support-knowledge.mjs"
WORKER_BLOG = "worker/blog-editorial.mjs"
WORKER_CHAT = "worker/site-chat.mjs"
WORKER_WHATSAPP = "worker/whatsapp-conversation.mjs"
SKU = {"vendas-na-pratica": "ZEV-VEN-011", "combo-ia-vendas": "ZEV-CMB-011", "negocio-completo": "ZEV-NGC-011"}

ALL_FILES = sorted({p for v in PRODUCT_PAGES.values() for p in v} | set(CATALOG_PAGES) | set(LLMS) | set(SOON_PAGES)
                   | {GENERATOR, WORKER_SUPPORT, WORKER_BLOG, WORKER_CHAT, WORKER_WHATSAPP})


def _scan(where: str, slug: str, text: str, problems: list[str]) -> None:
    n = norm(text)
    m = PROSPECT.search(n)
    if m:
        problems.append(f"{where}: atribui '{m.group(0)}' a {slug} (o material não ensina prospecção)")
    if slug == "combo-ia-vendas":
        m = INTEGRATED.search(n)
        if m:
            problems.append(f"{where}: afirma IA integrada ao fluxo de vendas no Combo ('{m.group(0)}'); "
                            "os dois treinamentos funcionam de forma independente")


def _segments(html: str, slug: str) -> list[str]:
    """Cartões (<article>/<li>) e linhas do recibo que apontam para o produto."""
    out = []
    href = re.compile(rf'href="[^"]*/{re.escape(slug)}"|href="#p-{re.escape(slug)}"|id="p-{re.escape(slug)}"')
    for tag in ("article", "li"):
        for m in re.finditer(rf"<{tag}\b[^>]*>(?:(?!<{tag}\b).)*?</{tag}>", html, re.S):
            if href.search(m.group(0)):
                out.append(m.group(0))
    return out


def check(files: dict[str, str]) -> list[str]:
    problems: list[str] = []
    missing = [p for p in ALL_FILES if p not in files]
    if missing:
        return [f"fonte ausente: {p}" for p in missing]
    for slug, pages in PRODUCT_PAGES.items():
        for page in pages:
            _scan(page, slug, files[page], problems)
    for page in CATALOG_PAGES:
        for slug in PRODUCTS:
            segs = _segments(files[page], slug)
            if not segs:
                problems.append(f"{page}: cartão de {slug} não encontrado (o gate não consegue verificar)")
            for seg in segs:
                _scan(f"{page} (cartão {slug})", slug, seg, problems)
    for page in LLMS:
        for line in files[page].splitlines():
            for slug in PRODUCTS:
                if f"/{slug})" in line:
                    _scan(f"{page} (linha {slug})", slug, line, problems)
    # Gerador das páginas de venda: COMMERCE/FIT e textos de prévia não citam prospecção nem integração.
    gen = files[GENERATOR]
    for slug in PRODUCTS:
        for m in re.finditer(rf"['\"]{re.escape(slug)}['\"]\s*:\s*[\[{{(]", gen):
            depth, i = 0, m.end() - 1
            while i < len(gen):
                depth += gen[i] in "[{(" and 1 or 0
                depth -= gen[i] in "]})" and 1 or 0
                if depth == 0:
                    break
                i += 1
            _scan(f"{GENERATOR} ({slug})", slug, gen[m.end() - 1:i + 1], problems)
    # Conhecimento do Worker usado para responder clientes.
    sup = files[WORKER_SUPPORT]
    for slug in PRODUCTS:
        m = re.search(rf'"{re.escape(slug)}":\s*\{{[^}}]*\}}', sup)
        if not m:
            problems.append(f"{WORKER_SUPPORT}: entrada de {slug} não encontrada")
        else:
            _scan(f"{WORKER_SUPPORT} ({slug})", slug, m.group(0), problems)
    blog = files[WORKER_BLOG]
    for slug, sku in SKU.items():
        start = blog.find(f'"{sku}": {{')
        if start < 0:
            problems.append(f"{WORKER_BLOG}: bloco {sku} não encontrado")
            continue
        nxt = re.search(r'\n  "ZEV-[A-Z]+-\d+": \{|\n\};', blog[start + 1:])
        block = blog[start: start + 1 + (nxt.start() if nxt else len(blog))]
        _scan(f"{WORKER_BLOG} ({sku})", slug, block, problems)
    chat = files[WORKER_CHAT]
    for line in chat.splitlines():
        for slug in PRODUCTS:
            if re.search(rf'^\s*\[/.*/,\s*"{re.escape(slug)}"\],?\s*$', line) and PROSPECT.search(norm(line)):
                problems.append(f"{WORKER_CHAT}: o roteamento de necessidade leva 'prospecção' a {slug}")
    wa = files[WORKER_WHATSAPP]
    for line in wa.splitlines():
        for slug in PRODUCTS:
            if slug in line or SKU[slug] in line or f'SUPPORT_PRODUCTS["{slug}"]' in line:
                _scan(f"{WORKER_WHATSAPP} (linha {slug})", slug, line, problems)
    # Mesma resposta da recomendação de vendas (o produto vem de uma linha anterior).
    for m in re.finditer(r"Para melhorar suas vendas, recomendo[^`]*`", wa):
        _scan(f"{WORKER_WHATSAPP} (recomendação de vendas)", "vendas-na-pratica", m.group(0), problems)
    # ZEVANORY SALES pode citar prospecção, mas só rotulado como indisponível.
    for page in SOON_PAGES:
        n = norm(files[page])
        if PROSPECT.search(n) and "em breve" not in n:
            problems.append(f"{page}: ZEVANORY SALES cita prospecção sem o rótulo 'Em breve'")
    for page in ("solucoes/index.html", "sales-public/solucoes.html", "sales-public/index.html"):
        for seg in _segments(files[page], "zevanory-sales"):
            n = norm(seg)
            if PROSPECT.search(n) and "em breve" not in n:
                problems.append(f"{page}: cartão do ZEVANORY SALES cita prospecção sem 'Em breve'")
    return problems


def load() -> dict[str, str]:
    return {p: (ROOT / p).read_text(encoding="utf-8") for p in ALL_FILES if (ROOT / p).exists()}


# Texto publicado antes desta correção (gh-pages d7daf4a). Cada mutante reinjeta UMA frase antiga
# no lugar da nova; o gate precisa reprovar cada uma.
MUTANTS = [
    ("vendas-na-pratica/index.html", "Método prático para organizar os pedidos e oportunidades que chegam: atendimento, oferta e follow-up, com clareza de próxima ação.",
     "Método prático para organizar prospecção, atendimento, oferta, follow-up e melhoria comercial com clareza de próxima ação."),
    ("sales-public/vendas-na-pratica.html", "<h3>Uma oferta que você consegue cumprir</h3>", "<h3>Quem abordar</h3>"),
    ("sales-public/vendas-na-pratica.html", "<strong>Oferta antes de entender o pedido</strong>", "<strong>Prospecção sem foco</strong>"),
    ("vendas-na-pratica/index.html", "<h2>Clareza sobre como atender, o que oferecer e o que fazer depois.</h2>",
     "<h2>Clareza sobre quem abordar, o que dizer e o que fazer depois.</h2>"),
    ("sales-public/combo-ia-vendas.html", "<h3>Uso independente</h3>", "<h3>IA dentro do fluxo</h3>"),
    ("combo-ia-vendas/index.html", "Os dois treinamentos juntos, que se complementam e podem ser usados de forma independente.</p>",
     "Dois métodos combinados para aplicar IA dentro do processo comercial real.</p>"),
    ("combo-ia-vendas/index.html", "Combo IA + Vendas | Os dois treinamentos juntos | ZEVANORY",
     "Combo IA + Vendas | Execução comercial com IA | ZEVANORY"),
    ("sales-public/combo-ia-vendas.html", "<li>Ordem sugerida para usar os dois.</li>", "<li>Aplicações integradas ao fluxo comercial.</li>"),
    ("negocio-completo/index.html", "<p>Transforme o atendimento, a oferta e o follow-up dos pedidos que chegam em um processo observável.</p>",
     "<p>Transforme prospecção, atendimento e follow-up em um processo observável.</p>"),
    ("sales-public/negocio-completo.html", "<p>Organize os pedidos e oportunidades que chegam (atendimento, oferta e follow-up) como uma sequência observável.</p>",
     "<p>Organize prospecção, atendimento, oferta e follow-up como uma sequência observável.</p>"),
    ("index.html", "<article><p>IA na Prática + Vendas na Prática</p>", "<article><p>IA e vendas trabalhando juntas</p>"),
    ("index.html", "Método prático para organizar os pedidos e oportunidades que chegam: atendimento, oferta, acompanhamento e aprendizado comercial.",
     "Método prático para organizar prospecção, atendimento, oferta, acompanhamento e aprendizado comercial."),
    ("solucoes/index.html", "Seu problema: IA e vendas, cada um no seu ritmo", "Seu problema: IA para vender mais"),
    ("kit-afiliado/index.html", "IA na Prática e Vendas na Prática: os dois treinamentos completos",
     "IA aplicada ao processo comercial: os dois treinamentos completos"),
    (GENERATOR, "'Quem quer usar IA no dia a dia e organizar as vendas pelo WhatsApp e nas redes'",
     "'Quem quer usar IA no dia a dia e organizar a prospecção pelo WhatsApp e nas redes'"),
    (WORKER_SUPPORT, "Método prático para organizar os pedidos e oportunidades que chegam: atendimento, oferta e follow-up, com clareza de próxima ação.",
     "Método prático para organizar prospecção, atendimento, oferta, follow-up e melhoria comercial com clareza de próxima ação."),
    (WORKER_SUPPORT, "Reúne IA na Prática e Vendas na Prática completos: os dois treinamentos, que se complementam e podem ser usados de forma independente.",
     "Combina o método de IA e o processo de vendas para organizar prospecção, atendimento, oferta, follow-up e produção comercial."),
    (WORKER_BLOG, "O Vendas na Prática organiza os pedidos e oportunidades que chegam, com atendimento",
     "O Vendas na Prática organiza prospecção, com atendimento"),
    (WORKER_BLOG, "Os dois treinamentos se complementam e funcionam de forma independente;",
     "Por isso, o combo conecta a IA a etapas definidas do processo de vender;"),
    (WORKER_CHAT, "[/(vend|cliente|atendimento|follow|", "[/(vend|cliente|prospec|atendimento|follow|"),
    (WORKER_WHATSAPP, "ajuda a organizar os pedidos e oportunidades que chegam: atendimento, oferta e follow-up.",
     "ajuda a organizar prospecção, atendimento, oferta e follow-up."),
    ("zevanory-sales/index.html", "Em breve: o ZEVANORY SALES ainda não está disponível para contratação.", ""),
]


def self_test() -> int:
    files = load()
    base = check(files)
    if base:
        print("SELF-TEST precondição: o repositório atual já reprova:\n  " + "\n  ".join(base))
        return 1
    survivors = []
    for path, new, old in MUTANTS:
        if files[path].count(new) < 1:
            survivors.append(f"{path}: âncora do mutante ausente: {new[:60]}")
            continue
        mutated = dict(files)
        mutated[path] = files[path].replace(new, old, 1)
        if not check(mutated):
            survivors.append(f"{path}: texto antigo NÃO reprovou: {old[:70]}")
    if survivors:
        print("SELF-TEST FAIL\n  " + "\n  ".join(survivors))
        return 1
    print(f"SALES_PROMISE_SELF_TEST=PASS mutants_killed={len(MUTANTS)}/{len(MUTANTS)}")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    root = Path(argv[argv.index("--root") + 1]) if "--root" in argv else ROOT
    files = {p: (root / p).read_text(encoding="utf-8") for p in ALL_FILES if (root / p).exists()}
    problems = check(files)
    if problems:
        print("SALES_PROMISE_CONSISTENCY=FAIL")
        for p in problems:
            print("  " + p)
        return 1
    print(f"SALES_PROMISE_CONSISTENCY=PASS files={len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
