#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from urllib.parse import quote

import sales_policy as policy

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("ZEVANORY_SALES_PUBLIC_OUT") or ROOT / "sales-public")  # P13: preview/teste do modo aberto fora do repo
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
    "conteudo-pronto",
    "kit-afiliado",
    "ia-por-ramo",
    "ia-para-salao-de-beleza",
    "ia-para-barbearia",
    "ia-para-restaurante-e-lanchonete",
    "ia-para-loja-de-roupas",
    "ia-para-mercadinho",
    "ia-para-oficina-mecanica",
    "ia-para-clinica-e-consultorio",
    "ia-para-academia",
    "ia-para-pet-shop",
    "ia-para-contabilidade",
    "ia-para-imobiliaria",
    "ia-para-deposito-de-bebidas",
    "ferramentas",
    "calculadora-preco-de-venda",
    "calculadora-margem-de-lucro",
    "calculadora-ponto-de-equilibrio",
    "ia-para-padaria",
    "ia-para-pizzaria",
    "ia-para-hamburgueria",
    "ia-para-acaiteria",
    "ia-para-confeitaria",
    "ia-para-farmacia",
    "ia-para-otica",
    "ia-para-papelaria",
    "ia-para-materiais-de-construcao",
    "ia-para-assistencia-tecnica-de-celular",
    "ia-para-autoescola",
    "ia-para-escola-de-idiomas",
    "ia-para-clinica-odontologica",
    "ia-para-psicologo",
    "ia-para-nutricionista",
    "ia-para-fisioterapia",
    "ia-para-estetica",
    "ia-para-manicure",
    "ia-para-lava-jato",
    "ia-para-eletricista-e-encanador",
    "ia-para-fotografo",
    "ia-para-arquitetura-e-design-de-interiores",
    "ia-para-advocacia",
    "ia-para-agencia-de-viagens",
    "ia-para-floricultura",
    "ia-para-marmitaria",
    "ia-para-pousada",
    "ia-para-distribuidora-de-gas-e-agua",
    "calculadora-fluxo-de-caixa",
    "calculadora-preco-hora-servico",
    "calculadora-taxa-maquininha",
    "calculadora-cmv",
    "mensagem-para-cliente-que-sumiu",
    "como-cobrar-cliente-pelo-whatsapp",
    "como-mandar-orcamento-pelo-whatsapp",
)


LEGAL_FOOTER = ('<div class="container footer-legal">'
                'A. RENAN ALVES MOREIRA BITU LTDA · CNPJ 69.077.233/0001-99 · Rua Francisco de Freitas Neto, 96, Casa Residencial, Alto do Tenente, '
                'Várzea Alegre/CE, CEP 63540-000 · <a href="mailto:suporte@zevanory.api.br">suporte@zevanory.api.br</a> · '
                'WhatsApp <a href="https://wa.me/5588992545413">+55 88 99254-5413</a>'
                # Official profiles verified by public readback (2026-10-12); rel="me" lets platforms
                # confirm the site <-> profile link.
                '<br>Perfis oficiais: '
                '<a rel="me noopener" href="https://www.youtube.com/@zevanory">YouTube</a> · '
                '<a rel="me noopener" href="https://www.instagram.com/zevanory_/">Instagram</a> · '
                '<a rel="me noopener" href="https://www.facebook.com/people/Zevanory/61593970292684/">Facebook</a> · '
                '<a rel="me noopener" href="https://www.tiktok.com/@zevanory">TikTok</a> · '
                '<a rel="me noopener" href="https://t.me/zevanory">Telegram</a> · '
                '<a rel="me noopener" href="https://bsky.app/profile/zevanoryoficial.bsky.social">Bluesky</a> · '
                '<a rel="me noopener" href="https://www.pinterest.com/zevanory/">Pinterest</a></div>')

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
FIT = {'ia-na-pratica': (['Dono de pequeno negócio que quer usar IA no dia a dia, sem curso longo', 'Quem já testou o ChatGPT mas não sabe aplicar em atendimento, conteúdo e rotina', 'Quem quer comandos prontos e uma planilha para medir o que mudou'], ['Quem procura automação técnica com programação', 'Quem espera resultado sem aplicar o método']), 'vendas-na-pratica': (['Quem vende pelo WhatsApp e Instagram e perde clientes no acompanhamento', 'Quem não tem roteiro de mensagens nem de conteúdo', 'Quem quer acompanhar oportunidades em uma planilha simples'], ['Quem busca anúncios pagos', 'Quem quer lista de contatos ou disparo em massa']), 'lucro-e-caixa': (['Quem fatura, mas não sabe quanto sobra no fim do mês', 'Quem mistura o dinheiro da empresa com o pessoal', 'Quem quer uma rotina semanal curta de caixa e margem'], ['Quem precisa de contabilidade ou obrigações fiscais', 'Quem procura recomendação de investimento']), 'combo-ia-vendas': (['Quem quer usar IA para vender mais no WhatsApp e nas redes', 'Quem quer os dois métodos com economia de R$ 97', 'Quem está organizando atendimento e conteúdo agora'], ['Quem só precisa organizar as finanças (veja Lucro & Caixa)', 'Quem busca anúncios pagos']), 'negocio-completo': (['Quem quer organizar IA, vendas e caixa de uma vez', 'Quem prefere um plano de 30 dias com começo, meio e fim', 'Quem quer a maior economia: R$ 244'], ['Quem quer resolver só um problema específico agora', 'Quem precisa de consultoria individual'])}
DELIVERY_Q = ("Como recebo o produto?", "Após a confirmação do pagamento (Pix ou cartão via Mercado Pago), você recebe por e-mail um " + policy.DELIVERY_72H + " do arquivo .zip com todo o material. A expiração do link não elimina o seu direito ao produto: peça outro sem custo em zevanory.api.br/entrega/reenviar.")
GUARANTEE_Q = ("E se não for para mim?", "Você pode desistir em " + policy.RULE_7D + ", sem justificativa e com devolução integral: peça em zevanory.api.br/pedir-reembolso.")
# P13: modo comercial do HTML estatico (padrao fechado; ver scripts/sales_policy.py).
MODE = policy.build_mode()

def _faq_html(q, a):
    return f"<details><summary>{q}</summary><p>{a}</p></details>"

def _attr(text: str) -> str:
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")

def sales_cta(c: dict, open_label: str, cls: str = "button primary") -> str:
    """CTA de compra. Fechado: lista de espera, sem link de checkout; o Worker restaura o CTA
    original (data-zev-sku + data-zev-open-text) somente quando /api/sales/status abre."""
    if MODE == policy.OPEN:
        return f'<a class="{cls}" href="/comprar/{c["sku"]}" rel="nofollow">{open_label}</a>'
    wa = "https://wa.me/5588992545413?text=" + quote("Olá! Quero entrar na lista de espera do " + c["name"] + ".")
    return (f'<a class="{cls}" href="{_attr(wa)}" data-zev-sku="{c["sku"]}" '
            f'data-zev-open-text="{_attr(open_label)}">{policy.WAITLIST_LABEL}</a>')

def mode_text(closed_text: str, open_text: str, tag: str = "span", cls: str = "") -> str:
    klass = f' class="{cls}"' if cls else ""
    if MODE == policy.OPEN:
        return f"<{tag}{klass}>{open_text}</{tag}>"
    return f'<{tag}{klass} data-zev-open-text="{_attr(open_text)}">{closed_text}</{tag}>'

def closed_note(tag: str = "p", cls: str = "microcopy sales-closed") -> str:
    if MODE == policy.OPEN:
        return ""
    return f'<{tag} class="{cls}" data-zev-closed>Preço informativo: {policy.CLOSED_LABEL}.</{tag}>'

def _esc(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def offer_summary(slug: str, kind: str, characteristics: str, price: int | None = None) -> str:
    """Decreto 7.962/2013, art. 2o: 'Resumo da oferta' estruturado (dl com data-field por item), em
    posicao ostensiva junto a oferta. Todos os dados vem de data/politica-unica.json (resumo_oferta)
    e do catalogo do build; nenhum campo pode ficar vazio ou com marcador de pendencia."""
    r = policy.RESUMO_OFERTA
    f = r["fornecedor"]
    terms = r[kind]
    values = {
        "fornecedor": f'{f["razao_social"]} (nome fantasia {f["nome_fantasia"]})',
        "cnpj": f["cnpj"],
        "endereco_fisico": f'{f["endereco_fisico"]}, CEP {f["cep"]}',
        "endereco_eletronico": f'{f["email"]} · WhatsApp {f["whatsapp"]} · {f["site"]}',
        "caracteristicas": characteristics,
        "preco_total": terms["preco_total"].replace("{price}", str(price)),
        "pagamento": terms["pagamento"],
        "disponibilidade": None,
        "entrega": terms["entrega"].replace("{delivery_72h}", policy.DELIVERY_72H),
        "restricoes": terms["restricoes"],
        "arrependimento": policy.CUSTOMER_RULE_7D + ", com devolução integral.",
    }
    rows = []
    for key, label in r["campos"]:
        if key == "disponibilidade":
            dd = mode_text(_esc(r["disponibilidade"]["closed"]), _esc(r["disponibilidade"]["open"]))
        else:
            val = values[key]
            if not str(val or "").strip() or any(m in str(val).upper() for m in policy.PENDING_MARKERS) or "{" in str(val):
                raise SystemExit(f"{slug}: resumo da oferta com campo '{key}' vazio ou pendente")
            dd = _esc(val)
        rows.append(f'<div data-field="{key}"><dt>{label}</dt><dd>{dd}</dd></div>')
    return (f'<section class="offer-summary" data-offer-summary="{slug}" aria-label="Resumo da oferta">'
            f'<h3>Resumo da oferta</h3><dl>{"".join(rows)}</dl></section>')

def apply_commerce(slug: str, html: str) -> str:
    c = COMMERCE[slug]
    label = f"Comprar agora · R$ {c['price']}"
    html = re.sub(r'<a class="nav-cta" href="mailto:[^"]*">', '<a class="nav-cta" href="https://wa.me/5588992545413">', html)
    # Every primary CTA buys (open) or joins the waiting list (closed).
    html = re.sub(r'<a class="button primary" href="mailto:[^"]*">[^<]*</a>', lambda m: sales_cta(c, label), html)
    html = re.sub(r'<p class="microcopy">[^<]*</p>', '<p class="microcopy">Pagamento pelo Mercado Pago (Pix ou cartão) · entrega por e-mail em ' + policy.DELIVERY_72H + ' · arrependimento em 7 dias corridos.</p>', html)
    trust = {
        ("Performance primeiro", "HTML semântico e zero dependência de JS para renderizar."): ("Entrega por link pessoal", "Por e-mail após a confirmação do pagamento: válido por 72 horas e para um download."),
        ("Gate antes da venda", "Checkout só após validação completa."): ("Arrependimento em 7 dias", "Contado da assinatura ou do recebimento, com devolução integral."),
        ("Transparência comercial", "Escopo e limites antes da contratação."): ("Pagamento seguro", "Pix ou cartão pelo Mercado Pago."),
    }
    for (old_t, old_s), (new_t, new_s) in trust.items():
        html = html.replace(f"<strong>{old_t}</strong><span>{old_s}</span>", f"<strong>{new_t}</strong><span>{new_s}</span>")
    items = "".join(f"<li>{i}</li>" for i in c["items"])
    aside = (f'<aside class="offer-side"><div><span class="status-pill">R$ {c["price"]} · pagamento único</span>'
             f'<h3>O que você recebe</h3><ul>{items}</ul>'
             + policy.POLICY_SUMMARY + closed_note()
             + offer_summary(slug, "produto_digital", "; ".join(c["items"]) + ".", c["price"]) +
             '</div>' + sales_cta(c, label) + '</aside>')
    html = re.sub(r'<aside class="offer-side">.*?</aside>', lambda m: aside, html, count=1, flags=re.S)
    # Conversion: what the buyer gets, right under the first call to action.
    chips = "".join(f"<li>{i}</li>" for i in c["items"][:4])
    includes = (closed_note() + f'<ul class="hero-includes" aria-label="O que está incluído">{chips}</ul>'
                '<p class="microcopy hero-trust">Empresa brasileira com CNPJ · criada por <a href="/quem-criou">Renan Bitu</a> · suporte humano no <a href="https://wa.me/5588992545413">WhatsApp</a></p>')
    html = re.sub(r'(<section class="container hero".*?<p class="microcopy">[^<]*</p>)', lambda m: m.group(1) + includes, html, count=1, flags=re.S)
    # Conversion: who it is for (and who it is not for), right after the trust strip.
    yes, no = FIT[slug]
    fit_html = ('<section class="container section fit-section" aria-labelledby="para-quem">'
                '<div class="section-head"><p class="section-kicker">Para quem é</p>'
                f'<h2 id="para-quem">Feito para quem vive o problema todo dia.</h2></div>'
                '<div class="fit-grid"><div class="fit-card fit-yes"><h3>É para você se</h3><ul>'
                + "".join(f"<li>{x}</li>" for x in yes) +
                '</ul></div><div class="fit-card fit-no"><h3>Não é para você se</h3><ul>'
                + "".join(f"<li>{x}</li>" for x in no) +
                '</ul></div></div></section>')
    html = re.sub(r'(<section class="trust-strip".*?</section>)', lambda m: m.group(1) + fit_html, html, count=1, flags=re.S)
    # Conversion: a compact bar that follows the reader on phones (72 h / um download beside the CTA).
    bar = (f'<div class="buy-bar" role="region" aria-label="Oferta {c["name"]}"><div><strong>{c["name"]}</strong>'
           + mode_text(f'R$ {c["price"]} · {policy.CLOSED_LABEL}', f'R$ {c["price"]} · link de 72 h, um download')
           + '</div>' + sales_cta(c, "Comprar") + '</div>')
    html = html.replace("</main>", bar + "</main>", 1)
    # FAQ: drop "when will sales open" and fix composition answers; add delivery + withdrawal.
    html = re.sub(r'<details><summary>Quando (a compra|o checkout) será liberad[ao]\?</summary><p>[^<]*</p></details>', _faq_html(*DELIVERY_Q) + _faq_html(*GUARANTEE_Q), html)
    if c["faq_q"]:
        q, a = c["faq_q"]
        html = re.sub(rf'(<summary>{re.escape(q)}</summary><p>)[^<]*(</p>)', rf'\g<1>{a}\g<2>', html)
    # Structured data. Fechado: sem Offer (nao se anuncia disponibilidade nem pre-venda que nao
    # existe). Aberto: Offer InStock — o Worker gera a mesma Offer em tempo de execucao.
    def fix_ld(m):
        import json as _json
        data = _json.loads(m.group(2))
        for node in data.get("@graph", []):
            if node.get("@type") == "Product":
                if MODE == policy.OPEN:
                    node["offers"] = {"@type": "Offer", "price": f"{c['price']}.00", "priceCurrency": "BRL", "availability": "https://schema.org/InStock",
                                      "url": f"{SALES_ORIGIN}/{slug}", "seller": {"@type": "Organization", "name": "A. RENAN ALVES MOREIRA BITU LTDA"}}
                else:
                    node.pop("offers", None)
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
    html = html.replace("com escopo explícito e venda condicionada a gates reais.", "com escopo explícito, pagamento seguro e arrependimento em 7 dias.")
    for slug, c in COMMERCE.items():
        tag = mode_text(f'R$ {c["price"]} · {policy.CLOSED_LABEL}', f'R$ {c["price"]} · link de 72 h, um download', cls="catalog-type")
        html = re.sub(rf'(<a class="catalog-card" href="/{slug}">.*?<p>[^<]*</p>)', lambda m: m.group(1) + tag, html, count=1, flags=re.S)
    sub_tag = mode_text(f"R$ 197/mês · {policy.CLOSED_LABEL}", "R$ 197/mês · entrega automática por e-mail", cls="catalog-type")
    html = re.sub(r'(<a class="catalog-card" href="/conteudo-pronto">.*?<p>[^<]*</p>)', lambda m: m.group(1) + sub_tag, html, count=1, flags=re.S)
    for slug in ("zevanory-sales", "zevanory-cfo", "arbm-contador-saloes"):
        html = re.sub(rf'(<a class="catalog-card" href="/{slug}">.*?<p>[^<]*</p>)', r'\g<1><span class="catalog-type">Em breve</span>', html, count=1, flags=re.S)
    return html

SUBSCRIPTION_OFFER = {"@type": "Offer", "price": "197.00", "priceCurrency": "BRL", "url": f"{SALES_ORIGIN}/conteudo-pronto"}

def apply_subscription(html: str) -> str:
    """P13: Conteudo Pronto. A fonte ja vem fechada (CTA de espera com data-zev-sub, sem Offer);
    aqui entram o resumo da politica e o rotulo ao lado do CTA, e o modo aberto (preview)."""
    if html.count('data-zev-sub="conteudo-pronto"') < 1 or "/assinar/" in html:
        raise SystemExit("conteudo-pronto: fonte fora do modo fechado")
    html = re.sub(r'(<a class="button primary" [^>]*data-zev-sub="conteudo-pronto"[^>]*>[^<]*</a></p><p class="microcopy">[^<]*</p>)',
                  lambda m: m.group(1) + policy.SUBSCRIPTION_SUMMARY + closed_note()
                  + offer_summary("conteudo-pronto", "assinatura", policy.RESUMO_OFERTA["assinatura"]["caracteristicas"]), html, count=1)
    if policy.SUBSCRIPTION_SUMMARY not in html:
        raise SystemExit("conteudo-pronto: ancora do CTA principal nao encontrada")
    if MODE == policy.OPEN:
        html = re.sub(r'<a class="button primary" href="[^"]*" data-zev-sub="conteudo-pronto" data-zev-open-text="([^"]*)">[^<]*</a>',
                      r'<a class="button primary" href="/assinar/conteudo-pronto">\1</a>', html)
        def add_offer(m):
            data = json.loads(m.group(2))
            for node in data.get("@graph", []):
                if node.get("@type") == "Service":
                    node["offers"] = dict(SUBSCRIPTION_OFFER)
            return m.group(1) + json.dumps(data, ensure_ascii=False) + m.group(3)
        html = re.sub(r'(<script type="application/ld\+json">)(.*?)(</script>)', add_offer, html, count=1, flags=re.S)
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
        if slug == "conteudo-pronto":
            html = apply_subscription(html)
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
    shutil.copy2(ROOT / "ferramentas.js", OUT / "ferramentas.js")
    shutil.copy2(OVERLAY / "llms.txt", OUT / "llms.txt")

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
        if MODE == policy.OPEN and f'href="/comprar/{COMMERCE[slug]["sku"]}"' not in page:
            problems.append(f"{slug}: buy button missing")
        if MODE == policy.CLOSED and (f'data-zev-sku="{COMMERCE[slug]["sku"]}"' not in page or policy.CLOSED_LABEL not in page):
            problems.append(f"{slug}: waiting-list CTA or closed label missing")
        for banned in ("gates oficiais", "Gate antes da venda", "será liberad", "pagamento reconciliado", "mailto:contato@"):
            if banned in page:
                problems.append(f"{slug}: banned pre-sale copy '{banned}'")
        if "CNPJ 69.077.233/0001-99" not in page:
            problems.append(f"{slug}: supplier identification missing")
        if (MODE == policy.OPEN) != ('"offers"' in page):
            problems.append(f"{slug}: structured offer does not match mode {MODE}")
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
    sitemap = re.sub(r"\s*<url><loc>https://zevanory\.api\.br/blog(?:/[^<]+)?</loc>.*?</url>", "", sitemap, flags=re.S)
    sitemap = sitemap.replace("<loc>https://zevanory.api.br/", "<loc>https://vendas.zevanory.api.br/")
    (OUT / "sitemap.xml").write_text(sitemap, encoding="utf-8")
    shutil.copytree(ROOT / "brand", OUT / "brand")
    (OUT / "assets").mkdir(exist_ok=True)
    portrait = ROOT / "assets" / "renan-bitu.webp"
    if not portrait.is_file() or portrait.stat().st_size != 22838:
        raise SystemExit("founder portrait missing or unexpected size")
    shutil.copy2(portrait, OUT / "assets" / "renan-bitu.webp")
    # Approved social/creative brand assets live in the overlay (2026-10-02).
    shutil.copytree(OVERLAY / "brand", OUT / "brand", dirs_exist_ok=True)
    # Official exported brand PNGs (link-card for Open Graph, kit de afiliado, avatars, banners).
    # Pages reference /brand/export/<file>.png on the sales domain; without this copy they 404'd.
    exports = ROOT / "assets" / "brand" / "export"
    (OUT / "brand" / "export").mkdir(parents=True, exist_ok=True)
    for png in sorted(exports.glob("*.png")):
        shutil.copy2(png, OUT / "brand" / "export" / png.name)
    if not (OUT / "brand" / "export" / "link-card.png").is_file():
        raise SystemExit("official link-card export missing from sales build")

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

    # P13: politica unica em todas as superficies e grep-gate do modo fechado (NO-GO).
    p13 = policy.audit_policy(OUT, PRODUCTS)
    if MODE == policy.CLOSED:
        p13 += policy.audit_closed(OUT)
    if p13:
        raise SystemExit("P13 policy/NO-GO contract failed: " + "; ".join(p13))
    print("ZEVANORY_SALES_MODE=" + MODE)

    built = sorted(p.name for p in OUT.glob("*.html"))
    print("ZEVANORY_SALES_PUBLIC_BUILD=PASS")
    print("HTML_ASSETS=" + ",".join(built))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
