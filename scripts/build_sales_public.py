#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

import sales_policy as policy
import sales_marketing as mk

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


# Company identification footer (P13c: identification and address from data/politica-unica.json).
# Design (2026-10-24): three labelled blocks (company, contact, official profiles) instead of a
# "A · B · C" chain. Contact is e-mail + protocol form only (WhatsApp banned by Meta; the
# contato_publico.whatsapp_public_links_enabled lock still gates it).
_SOCIAL = (("YouTube", "https://www.youtube.com/@zevanory"), ("Instagram", "https://www.instagram.com/zevanory_/"),
           ("Facebook", "https://www.facebook.com/people/Zevanory/61593970292684/"), ("TikTok", "https://www.tiktok.com/@zevanory"),
           ("Telegram", "https://t.me/zevanory"), ("Bluesky", "https://bsky.app/profile/zevanoryoficial.bsky.social"),
           ("Pinterest", "https://www.pinterest.com/zevanory/"))
LEGAL_FOOTER = ('<div class="container footer-legal">'
                # Marketing (closed-sales phase): the free checklist and calculators are the primary no-cost action.
                + mk.FREE_FOOTER +
                '<section class="fl-block" aria-labelledby="fl-empresa"><h2 class="fl-title" id="fl-empresa">Empresa</h2>'
                f'<p>{policy.SUPPLIER["razao_social"]}<br>CNPJ {policy.SUPPLIER["cnpj"]}<br>{policy.ADDRESS_FULL}</p></section>'
                '<section class="fl-block" aria-labelledby="fl-contato"><h2 class="fl-title" id="fl-contato">Atendimento</h2><ul>'
                f'<li><a href="mailto:{policy.SUPPORT_EMAIL}">{policy.SUPPORT_EMAIL}</a></li>'
                f'<li><a href="{policy.CONTACT["formulario"]}">Atendimento com protocolo</a></li>'
                '<li class="fl-note">Confirmação na hora e resposta conclusiva em até 5 dias.</li>'
                + (f'<li>WhatsApp <a href="{policy.WHATSAPP_URL}">{policy.WHATSAPP_DISPLAY}</a></li>' if policy.WHATSAPP_PUBLIC_LINKS_ENABLED else '') +
                '</ul></section>'
                '<section class="fl-block" aria-labelledby="fl-regras"><h2 class="fl-title" id="fl-regras">Regras da compra</h2><ul>'
                '<li><a href="/termos">Termos de compra</a></li><li><a href="/privacidade">Privacidade</a></li>'
                '<li><a href="/reembolso">Arrependimento e reembolso</a></li></ul></section>'
                # Official profiles verified by public readback (2026-10-12); rel="me" lets platforms
                # confirm the site <-> profile link.
                '<section class="fl-block" aria-labelledby="fl-perfis"><h2 class="fl-title" id="fl-perfis">Perfis oficiais</h2><ul class="fl-social">'
                + "".join(f'<li><a rel="me noopener" href="{u}">{n}</a></li>' for n, u in _SOCIAL) +
                '</ul></section></div>')

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
# Contato humano no hero: WhatsApp só quando operacional; senão, o e-mail que funciona.
HUMAN_SUPPORT = (f'no <a href="{policy.WHATSAPP_URL}">WhatsApp</a>' if policy.WHATSAPP_PUBLIC_LINKS_ENABLED
                 else f'por <a href="mailto:{policy.SUPPORT_EMAIL}">e-mail</a>')
DELIVERY_Q = ("Como recebo o produto?", "Após a confirmação do pagamento (Pix ou cartão via Mercado Pago), você recebe por e-mail um " + policy.DELIVERY_72H + " do arquivo .zip com todo o material. A expiração do link não elimina o seu direito ao produto: peça outro sem custo em zevanory.api.br/entrega/reenviar.")
GUARANTEE_Q = ("E se não for para mim?", "Você pode desistir em " + policy.RULE_7D + ", sem justificativa e com devolução integral: peça em zevanory.api.br/pedir-reembolso.")
# P13: modo comercial do HTML estatico (padrao fechado; ver scripts/sales_policy.py).
MODE = policy.build_mode()

def buy_facts() -> str:
    return ('<ul class="facts buy-facts"><li>Pagamento processado pelo Mercado Pago (Pix ou cartão)</li>'
            f'<li>Entrega por e-mail em {policy.DELIVERY_72H}</li>'
            '<li>Arrependimento em 7 dias corridos, com devolução integral</li></ul>')

# Response commitment as documented in /termos (section 8): protocol on the spot, conclusive answer in 5 days.
RESPONSE_COMMITMENT = "confirmação na hora e resposta conclusiva em até 5 dias"

def trust_mini(payment: str = "pelo Mercado Pago") -> str:
    """Compact, factual trust block next to every price (data from data/politica-unica.json)."""
    f = policy.SUPPLIER
    return ('<ul class="trust-mini" aria-label="Quem vende e como funciona">'
            f'<li><strong>Empresa brasileira</strong><span>{f["razao_social"]}, <span class="nowrap">CNPJ {f["cnpj"]}</span>, Várzea Alegre (CE)</span></li>'
            f'<li><strong>Pagamento</strong><span>processado {payment}</span></li>'
            f'<li><strong>Suporte</strong><span><a href="mailto:{policy.SUPPORT_EMAIL}">{policy.SUPPORT_EMAIL}</a><span class="tm-note">{RESPONSE_COMMITMENT[0].upper() + RESPONSE_COMMITMENT[1:]}.</span></span></li>'
            '<li><strong>Regras</strong><span><a href="/termos">Termos</a>, <a href="/privacidade">Privacidade</a> e <a href="/reembolso">Reembolso</a></span></li></ul>')

def how_to_buy() -> str:
    """Full trust block (solucoes, quem-criou): how a purchase works, step by step, and who sells.
    Every sentence restates /termos (sections 1, 3, 4, 6 and 8); nothing new is promised."""
    f = policy.SUPPLIER
    return ('<section class="container how-to-buy" aria-labelledby="como-compra"><h2 id="como-compra">Como a compra funciona</h2>'
            '<ol class="steps">'
            '<li><strong>Pagamento</strong><span>Pix ou cartão, processado pelo Mercado Pago. A ZEVANORY não recebe nem armazena dados de cartão.</span></li>'
            '<li><strong>E-mail</strong><span>Depois da confirmação do pagamento, o link chega no e-mail que você informou.</span></li>'
            f'<li><strong>Link pessoal</strong><span>{policy.DELIVERY_72H[0].upper() + policy.DELIVERY_72H[1:]}. Se expirar, o suporte envia outro sem custo.</span></li>'
            '<li><strong>7 dias</strong><span>Para desistir, sem justificativa, com devolução integral.</span></li></ol>'
            '<p class="steps-note">O Conteúdo Pronto é uma assinatura mensal cobrada pela Hotmart.</p>'
            '<dl class="seller">'
            f'<div><dt>Quem vende</dt><dd>{f["razao_social"]}, empresa brasileira</dd></div>'
            f'<div><dt>CNPJ</dt><dd>{f["cnpj"]}</dd></div>'
            '<div><dt>Onde</dt><dd>Várzea Alegre, Ceará</dd></div>'
            f'<div><dt>Suporte</dt><dd><a href="mailto:{policy.SUPPORT_EMAIL}">{policy.SUPPORT_EMAIL}</a><br>{RESPONSE_COMMITMENT[0].upper() + RESPONSE_COMMITMENT[1:]}</dd></div>'
            '</dl></section>')

# Real product previews (owner authorisation, in writing: "AUTORIZO PRÉVIAS REAIS DOS PRODUTOS NO SITE";
# Sol 228 content rules). Per product at most three images: manual cover, ONE inner page, ONE spreadsheet
# crop. Provenance per image (zip + SHA-256, path in zip, page/crop, redactions, output SHA-256 of WebP and
# AVIF) is committed in docs/evidence/sales-ux/previews-manifest.json; tests recompute the hashes.
PREVIEW_MANIFEST = json.loads((ROOT / "docs" / "evidence" / "sales-ux" / "previews-manifest.json").read_text(encoding="utf-8"))
_PREVIEWS = {i["id"]: i for i in PREVIEW_MANIFEST["images"]}
PREVIEW_TEXT = {
    "manual-ia-capa": ("Capa do manual", "Capa do manual IA na Prática, com o público, o formato e a lista das oito aulas"),
    "manual-ia-aula-a1": ("Uma página interna: aula A1", "Página da aula A1 do manual IA na Prática: objetivo, exemplo comentado e exercício"),
    "planilha-ia-orcamento": ("Trecho da planilha: aba Orçamento", "Trecho da planilha do IA na Prática, aba Orçamento, com as colunas item, quantidade, unitário, subtotal e conferência"),
    "manual-vendas-capa": ("Capa do manual", "Capa do manual Vendas na Prática, com o público, o formato e a lista das oito aulas"),
    "manual-vendas-aula-b1": ("Uma página interna: aula B1", "Página da aula B1 do manual Vendas na Prática: defina uma oferta que você consegue cumprir"),
    "planilha-vendas-oportunidades": ("Trecho da planilha: aba Oportunidades", "Trecho da planilha comercial do Vendas na Prática, aba Oportunidades, com origem, etapa, resultado, proposta e próxima ação"),
    "manual-lucro-capa": ("Capa do manual", "Capa do manual Lucro & Caixa: o que o produto resolve e como usar a planilha"),
    "manual-lucro-modulo-1": ("Uma página interna: módulos 1 e 2", "Página do manual Lucro & Caixa com os módulos 1 e 2: faturamento x resultado e mapa de custos"),
    "planilha-lucro-painel": ("Trecho da planilha: Painel de Decisão", "Trecho da planilha Lucro & Caixa, Painel de Decisão, com os rótulos dos indicadores; a coluna de leitura está oculta"),
    "plano-30-dias-capa": ("Capa do plano de 30 dias", "Capa do Plano integrado de 30 dias do Negócio Completo, com o modo de uso e a semana 1"),
    "plano-30-dias-semana-2": ("Uma página interna: semana 2", "Trecho da semana 2 do Plano integrado de 30 dias: ações diárias de vendas e acompanhamento"),
    "painel-decisao-integrada": ("Trecho do Painel de Decisão Integrada", "Trecho do Painel de Decisão Integrada do Negócio Completo, com os títulos das colunas por produto ou serviço"),
}

def _picture(iid: str, cls: str = "", alt_suffix: str = "") -> str:
    i = _PREVIEWS[iid]
    k = f' class="{cls}"' if cls else ""
    return (f'<picture><source type="image/avif" srcset="/{i["avif"]["file"]}">'
            f'<img{k} src="/{i["webp"]["file"]}" width="{i["width"]}" height="{i["height"]}" loading="lazy" decoding="async" '
            f'alt="{_attr(PREVIEW_TEXT[iid][1] + alt_suffix)}"></picture>')

def preview_section(slug: str) -> str:
    ids = PREVIEW_MANIFEST["per_product"].get(slug) or []
    if not ids:
        return ""
    if len(ids) > 3:
        raise SystemExit(f"{slug}: more than three preview images (owner authorisation is three)")
    figs = "".join(f'<figure class="inside-item">{_picture(i)}<figcaption>{PREVIEW_TEXT[i][0]}<span class="inside-label">{_PREVIEWS[i]["label"]}</span></figcaption></figure>' for i in ids)
    note = (" O Combo traz o IA na Prática e o Vendas na Prática completos; as imagens são desses materiais." if slug == "combo-ia-vendas" else "")
    return ('<section class="container section inside" aria-labelledby="por-dentro"><div class="section-head">'
            '<h2 id="por-dentro">Veja por dentro</h2><p class="section-lead">Páginas reais do material, reduzidas para visualização: a capa, '
            'uma página interna e um trecho da planilha. O conteúdo completo vem na compra.' + note + '</p></div>'
            f'<div class="inside-grid">{figs}</div></section>')

def catalog_thumb(slug: str) -> str:
    """Cover thumbnail; when the approved inner page is a whole page of the same format, it sits behind
    the cover as a real two-page stack (no new content: both images are already in "Veja por dentro")."""
    ids = PREVIEW_MANIFEST["per_product"].get(slug) or []
    if not ids:
        return ""
    front = _PREVIEWS[ids[0]]
    back = _PREVIEWS[ids[1]] if len(ids) > 1 else None
    same_format = back is not None and not back["crop_box"] and abs(back["width"] / back["height"] - front["width"] / front["height"]) < 0.01
    behind = (f'<span class="cc-page cc-page-back" aria-hidden="true">{_picture(back["id"], "", "")}</span>'.replace(f'alt="{_attr(PREVIEW_TEXT[back["id"]][1])}"', 'alt=""')
              if same_format else "")
    return (f'<span class="cc-thumb{" cc-stack" if same_format else ""}">{behind}'
            f'<span class="cc-page">{_picture(ids[0], "", " (" + front["label"] + ")")}</span></span>')

def _faq_html(q, a):
    return f"<details><summary>{q}</summary><p>{a}</p></details>"

def _attr(text: str) -> str:
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")

def sales_cta(c: dict, open_label: str, cls: str = "button primary") -> str:
    """CTA de compra. Fechado: lista de espera, sem link de checkout; o Worker restaura o CTA
    original (data-zev-sku + data-zev-open-text) somente quando /api/sales/status abre."""
    if MODE == policy.OPEN:
        return f'<a class="{cls}" href="/comprar/{c["sku"]}" rel="nofollow">{open_label}</a>'
    # Destino da lista de espera: e-mail (mailto com assunto/corpo fixos) enquanto o WhatsApp não
    # está operacional; ver contato_publico em data/politica-unica.json.
    return (f'<a class="{cls}" href="{_attr(policy.waitlist_href(c["name"]))}" data-zev-sku="{c["sku"]}" '
            f'data-zev-open-text="{_attr(open_label)}">{policy.WAITLIST_LABEL}</a>')

def mode_text(closed_text: str, open_text: str, tag: str = "span", cls: str = "") -> str:
    klass = f' class="{cls}"' if cls else ""
    if MODE == policy.OPEN:
        return f"<{tag}{klass}>{open_text}</{tag}>"
    return f'<{tag}{klass} data-zev-open-text="{_attr(open_text)}">{closed_text}</{tag}>'

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
        # Decreto 7.962/2013, art. 2º, II: só endereços que funcionam (e-mail e site; WhatsApp banido).
        "endereco_eletronico": " · ".join([f["email"]] + ([f'WhatsApp {policy.WHATSAPP_DISPLAY}'] if policy.WHATSAPP_PUBLIC_LINKS_ENABLED else []) + [f["site"]]),
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
    html = re.sub(r'<a class="nav-cta" href="mailto:[^"]*">', lambda m: f'<a class="nav-cta" href="{_attr(policy.contact_href())}">', html)
    # Every primary CTA buys (open) or joins the waiting list (closed).
    html = re.sub(r'<a class="button primary" href="mailto:[^"]*">[^<]*</a>', lambda m: sales_cta(c, label), html)
    # Design: the payment/delivery/withdrawal facts as a short list, not a "·" chain. Each item has an
    # exact Hotmart counterpart in worker/sales-public-worker.mjs (HOTMART_TEXT).
    html = re.sub(r'<p class="microcopy">[^<]*</p>', lambda m: buy_facts(), html, count=1)
    trust = {
        ("Performance primeiro", "HTML semântico e zero dependência de JS para renderizar."): ("Entrega por link pessoal", "Por e-mail após a confirmação do pagamento: válido por 72 horas e para um download."),
        ("Gate antes da venda", "Checkout só após validação completa."): ("Arrependimento em 7 dias", "Contado da assinatura ou do recebimento, com devolução integral."),
        ("Transparência comercial", "Escopo e limites antes da contratação."): ("Pagamento seguro", "Pix ou cartão pelo Mercado Pago."),
    }
    for (old_t, old_s), (new_t, new_s) in trust.items():
        html = html.replace(f"<strong>{old_t}</strong><span>{old_s}</span>", f"<strong>{new_t}</strong><span>{new_s}</span>")
    items = "".join(f"<li>{i}</li>" for i in c["items"])
    # Design (2026-10-24): "vendas temporariamente fechadas" is said ONCE per page by the site notice
    # (sales_notice); the legal Resumo da oferta keeps its own Disponibilidade field.
    aside = (f'<div class="offer-side"><div><span class="status-pill">R$ {c["price"]} · pagamento único</span>'
             f'<h3>O que você recebe</h3><ul>{items}</ul>'
             + policy.POLICY_SUMMARY
             + offer_summary(slug, "produto_digital", "; ".join(c["items"]) + ".", c["price"]) +
             '</div>' + sales_cta(c, label) + '</div>')
    html = re.sub(r'<aside class="offer-side">.*?</aside>', lambda m: aside, html, count=1, flags=re.S)
    # Hero: the product's name above the claim, and its receipt (what you get, the total) beside it.
    html = re.sub(r'(<section class="container hero"><div>)<p class="eyebrow">[^<]*</p>', lambda m: m.group(1) + f'<p class="kicker">{c["name"]}</p>', html, count=1)
    receipt = (f'<div class="hero-panel receipt"><p class="receipt-head">O que você recebe<span>pagamento único</span></p>'
               f'<ul class="outcome-list">{items}</ul>'
               f'<p class="receipt-total"><span>Total</span><span>R$ {c["price"]}</span></p>'
               + trust_mini() + '</div>')
    html = re.sub(r'<aside class="hero-panel">.*?</aside>', lambda m: receipt, html, count=1, flags=re.S)
    includes = ('<p class="byline hero-trust">Feito por <a href="/quem-criou">Renan Bitu</a>, em Várzea Alegre (CE). Suporte humano ' + HUMAN_SUPPORT + '.</p>'
                + mk.FREE_PRODUCT_LINE)
    html = re.sub(r'(<section class="container hero".*?<ul class="facts buy-facts">.*?</ul>)', lambda m: m.group(1) + includes, html, count=1, flags=re.S)
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
    # Marketing: a labelled fictional worked example (real structure of the product) and, only when the owner
    # has added real consented testimonials, the testimonial section (none while data/depoimentos.json is empty).
    html = re.sub(r'(<section class="trust-strip".*?</section>)', lambda m: m.group(1) + fit_html + preview_section(slug)
                  + mk.product_example(slug) + mk.testimonials_section(DEPOIMENTOS, slug), html, count=1, flags=re.S)
    # Conversion: a compact bar that follows the reader on phones (72 h / um download beside the CTA).
    bar = (f'<div class="buy-bar" role="region" aria-label="Oferta {c["name"]}"><div><strong>{c["name"]}</strong>'
           + f'<span>R$ {c["price"]} · pagamento único</span>'
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
    # FAQ (marketing): formats, spreadsheet skills, niche fit, no subscription, what the waiting list does.
    return mk.extend_faq(html, mk.product_faq(slug, c["price"]), slug)

CATALOG_INCLUDES = {  # the most concrete deliverables of each paid product, picked from COMMERCE (never invented)
    "lucro-e-caixa": (2, 3, 4), "vendas-na-pratica": (2, 3, 4), "ia-na-pratica": (2, 3, 0),
    "combo-ia-vendas": (0, 1, 2), "negocio-completo": (3, 4, 5)}

def apply_marketing_catalog(html: str) -> str:
    return apply_solucoes_marketing(apply_catalog(html))

def apply_catalog(html: str) -> str:
    """Catalogue by problem (solucoes/index.html). For each paid product the build adds what you get
    (its real deliverables, from COMMERCE) and its price; free and "Em breve" status are in the source.
    Closed status is the single page notice, not repeated per card."""
    prices = {slug: (f'R$ {c["price"]}', "pagamento único") for slug, c in COMMERCE.items()}
    prices["conteudo-pronto"] = ("R$ 197", "por mês")
    for slug, (price, unit) in prices.items():
        inc = ""
        if slug in CATALOG_INCLUDES:
            items = [re.sub(r"\s*\([^)]*\)", "", COMMERCE[slug]["items"][k]) for k in CATALOG_INCLUDES[slug]]
            inc = '<ul class="catalog-includes">' + "".join(f"<li>{i}</li>" for i in items) + "</ul>"
        pat = rf'(<article class="catalog-card[^"]*"[^>]*><div class="cc-main">(?:<p class="cc-match">[^<]*</p>)?<h3><a href="/{slug}">[^<]*</a></h3><p>[^<]*</p>)((?:<ul class="catalog-includes">.*?</ul>)?</div>)'
        thumb = catalog_thumb(slug)
        html, n = re.subn(pat, lambda m: m.group(1) + inc + m.group(2) + f'<p class="catalog-price">{price}<span>{unit}</span></p>' + thumb, html, count=1, flags=re.S)
        if n != 1:
            raise SystemExit(f"solucoes: catalog card for {slug} missing")
    return html

SUBSCRIPTION_OFFER = {"@type": "Offer", "price": "197.00", "priceCurrency": "BRL", "url": f"{SALES_ORIGIN}/conteudo-pronto"}

def apply_subscription(html: str) -> str:
    """P13: Conteudo Pronto. A fonte ja vem fechada (CTA de espera com data-zev-sub, sem Offer);
    aqui entram o resumo da politica e o rotulo ao lado do CTA, e o modo aberto (preview)."""
    if html.count('data-zev-sub="conteudo-pronto"') < 1 or "/assinar/" in html:
        raise SystemExit("conteudo-pronto: fonte fora do modo fechado")
    html = re.sub(r'(<a class="button primary" [^>]*data-zev-sub="conteudo-pronto"[^>]*>[^<]*</a></p><p class="microcopy">[^<]*</p>)',
                  lambda m: m.group(1) + policy.SUBSCRIPTION_SUMMARY
                  + offer_summary("conteudo-pronto", "assinatura", policy.RESUMO_OFERTA["assinatura"]["caracteristicas"]), html, count=1)
    if policy.SUBSCRIPTION_SUMMARY not in html:
        raise SystemExit("conteudo-pronto: ancora do CTA principal nao encontrada")
    # The summary sits in the hero, right under the h1: an h2 keeps the heading order (Lighthouse heading-order).
    html = html.replace('aria-label="Resumo da oferta"><h3>Resumo da oferta</h3>', 'aria-label="Resumo da oferta"><h2>Resumo da oferta</h2>', 1)
    # Design: the monthly package as a receipt beside the hero (same facts as the page's own list).
    receipt = ('<div class="hero-panel receipt"><p class="receipt-head">Todo mês você recebe<span>sem fidelidade</span></p>'
               '<ul class="outcome-list"><li>12 posts com legenda, chamada para ação e hashtags</li>'
               '<li>4 mensagens de venda e acompanhamento</li><li>Calendário de 30 dias</li></ul>'
               '<p class="receipt-total"><span>Total</span><span>R$ 197/mês</span></p>'
               + trust_mini("pela Hotmart") + '</div>')
    html, n = re.subn(r'(<section class="container hero"><div>.*?</dl></section></div>)(</section>)', lambda m: m.group(1) + receipt + m.group(2), html, count=1, flags=re.S)
    if n != 1:
        raise SystemExit("conteudo-pronto: hero receipt anchor missing")
    # Destino da lista de espera vem do contato público (e-mail enquanto o WhatsApp não opera).
    html = re.sub(r'(<a class="button primary" )href="[^"]*"( data-zev-sub="conteudo-pronto")',
                  lambda m: m.group(1) + f'href="{_attr(policy.waitlist_href("Conteúdo Pronto"))}"' + m.group(2), html)
    html = re.sub(r'<a class="nav-cta" href="[^"]*">', lambda m: f'<a class="nav-cta" href="{_attr(policy.contact_href())}">', html)
    # Marketing: labelled fictional example right before the FAQ, extended FAQ, free first step in the hero.
    faq_at = html.find('<div class="faq">')
    sec_at = html.rfind("<section", 0, faq_at)
    if faq_at < 0 or sec_at < 0:
        raise SystemExit("conteudo-pronto: FAQ section missing")
    html = (html[:sec_at] + mk.example_block(mk.EXAMPLES["conteudo-pronto"], "exemplo", "Com o Conteúdo Pronto")
            + mk.testimonials_section(DEPOIMENTOS, "conteudo-pronto") + html[sec_at:])
    html = mk.extend_faq(html, mk.SUBSCRIPTION_FAQ, "conteudo-pronto")
    html, n = re.subn(r'(<div class="hero-panel receipt">)', lambda m: mk.FREE_PRODUCT_LINE.replace('<p class="free-next">', '<p class="free-next cp-free">') + m.group(1), html, count=1)
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

PRICE_PAGES = set(PRODUCTS) | {"solucoes", "conteudo-pronto"} | set(mk.NICHE_PAGES)
# Testimonials: refused at build time unless every entry is real and consented (see scripts/sales_marketing.py).
DEPOIMENTOS = mk.load_depoimentos()

def apply_solucoes_marketing(html: str) -> str:
    """Catalogue (marketing): free calculators next to the free checklist in the hero, links to the niche
    pages, the demo video, testimonials only when real ones exist, and the FAQ with its JSON-LD."""
    html, n = re.subn(r'(<a class="button primary key" href="/material-gratuito">[^<]*</a>)',
                      lambda m: m.group(1) + '<a class="button secondary" href="/ferramentas">Usar as calculadoras grátis</a>', html, count=1)
    if n != 1:
        raise SystemExit("solucoes: checklist key missing")
    html, n = re.subn(r'(<p class="byline">Feito por )', '<p class="free-note">Grátis e sem cartão: o checklist abre na hora e as calculadoras não pedem cadastro.</p>\\1', html, count=1)
    if n != 1 or "<!--how-to-buy-->" not in html:
        raise SystemExit("solucoes: marketing anchors missing")
    html = html.replace("<!--how-to-buy-->", mk.niche_catalog_group() + mk.video_section() + mk.testimonials_section(DEPOIMENTOS)
                        + "<!--how-to-buy-->" + mk.faq_section(mk.SOLUCOES_FAQ), 1)
    return html.replace("</head>", mk.faq_ld_block(mk.SOLUCOES_FAQ) + "</head>", 1)

def sales_notice() -> str:
    """The one honest notice on pages that show prices (closed build only). <p> with plain text and
    data-zev-closed: the Worker removes it at request time when the owner opens sales."""
    if MODE == policy.OPEN:
        return ""
    return (f'<p class="sales-notice" data-zev-closed>Aviso: {policy.CLOSED_LABEL}. Os preços são informativos; '
            'entre na lista de espera e avisamos por e-mail quando abrir.</p>')

def apply_presentation(slug: str, html: str) -> str:
    """Design pass (docs/design/sales-site-identity.md), applied after every content/legal step:
    the hero label stays (sentence case, no caps), every other eyebrow/kicker goes; no arrow tics;
    buttons say what happens; asides that are not complementary content become plain blocks."""
    html = re.sub(r'(<section class="container hero"><div>)<p class="eyebrow">', r'\1<p class="kicker">', html, count=1)
    html = re.sub(r'<p class="(?:eyebrow|section-kicker)">[^<]*</p>', "", html)
    html = re.sub(r'(<span class="card-link">[^<]*?)\s*→\s*(</span>)', r"\1\2", html)
    html = html.replace(">Falar com a ZEVANORY</a>", ">Escrever para o suporte</a>")
    # The hero panel is part of the hero, not complementary content (axe landmark-complementary-is-top-level).
    # The offer block is part of the offer section too (the Decreto 7.962 tests anchor on the div).
    html = re.sub(r'<aside class="(hero-panel|offer-side)">(.*?)</aside>', r'<div class="\1">\2</div>', html, flags=re.S)
    html = html.replace('<nav class="site-nav"><a ', '<nav class="site-nav" aria-label="Navegação principal"><a ', 1)
    if slug in PRICE_PAGES and "sales-notice" not in html:
        # First thing inside <main> (inside a landmark, read right after the skip link).
        html = re.sub(r"(<main\b[^>]*>)", lambda m: m.group(1) + sales_notice(), html, count=1)
    return html

def add_legal_footer(html: str) -> str:
    if "footer-legal" in html:
        return html
    # Inside <main>: the product layout keeps a compact fixed footer, the identification scrolls with the page.
    if "</main>" in html:
        return html.replace("</main>", LEGAL_FOOTER + "</main>", 1)
    return html.replace("</body>", LEGAL_FOOTER + "</body>", 1)

def write_niche_pages() -> None:
    """/para/<ramo> landing pages (data/nichos.json), published flat as para-<ramo>.html so every
    page-level gate (P13 closed mode, contact, CSP, hashed assets) scans them like any other page; the
    Worker maps /para/<ramo> to them. Header and footer come from the catalogue source."""
    src = (OUT / "solucoes.html").read_text(encoding="utf-8")
    header = re.search(r'<header class="site-header">.*?</header>', src, re.S).group(0)
    footer = re.search(r'<footer class="site-footer">.*?</footer>', src, re.S).group(0)
    icon = re.search(r'<link rel="icon"[^>]*>', src).group(0)
    cta = sales_cta(COMMERCE["negocio-completo"], f'Comprar Negócio Completo · R$ {COMMERCE["negocio-completo"]["price"]}')
    for n in mk.NICHES:
        page = mk.niche_page(n, header, footer, icon, cta, how_to_buy(), trust_mini(), mode_text)
        (OUT / f"para-{n['slug']}.html").write_text(page, encoding="utf-8")

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
    for slug in HTML_ROUTES + mk.NICHE_PAGES:
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
            # O formulário de atendimento é servido pelo Worker central (zevanory.api.br/atendimento).
            lambda m: m.group(1) + m.group(2).replace("https://zevanory.api.br", SALES_ORIGIN).replace(SALES_ORIGIN + "/atendimento", "https://zevanory.api.br/atendimento") + m.group(3),
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
            html = apply_marketing_catalog(html)
        if slug == "conteudo-pronto":
            html = apply_subscription(html)
        html = html.replace("<!--how-to-buy-->", how_to_buy())
        html = apply_presentation(slug, html)
        html = add_legal_footer(html).replace("contato@zevanory.api.br", "suporte@zevanory.api.br")
        # Source pages may list both addresses ("contato@ ou suporte@"); after the public
        # canonicalization they would read "suporte@ ou suporte@". Collapse the duplicate.
        html = re.sub(r"suporte@zevanory\.api\.br( ou | or |, | e )suporte@zevanory\.api\.br", "suporte@zevanory.api.br", html)
        # E2 (2026-10-24): no contact script any more. The retired script only rewrote contato@
        # mailto links to suporte@, which the line above already does at build time; a returning
        # visitor's cached copy of its old, unhashed URL could still inject the banned number, so no
        # page references it (the Worker answers the old path with a no-store no-op).
        path.write_text(html, encoding="utf-8")
    shutil.copy2(ROOT / "legal.css", OUT / "legal.css")
    shutil.copy2(OVERLAY / "robots.txt", OUT / "robots.txt")
    # Chat do site (desligado por padrão: SITE_CHAT_ENABLED=false; o widget só é injetado pelo Worker quando ligado).
    for asset in ("site-chat.js", "site-chat.css"):
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

# E2: content-hashed assets. Every stylesheet and script a page loads is published as
# /assets/<name>.<sha256[:10]>.<ext> and served "immutable" by the Worker; HTML revalidates, so a
# deploy can never leave a returning visitor running a stale script or stylesheet. url() targets
# inside the CSS (fonts, images under /assets) are hashed first and rewritten to absolute paths.
FINGERPRINT = ("product.css", "legal.css", "ferramentas.js")
HASHED_RE = re.compile(r"^/assets/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.[0-9a-f]{10}\.(?:css|js|woff2)$")

def _hashed_name(rel: str, data: bytes) -> str:
    import hashlib
    stem, ext = rel.rsplit(".", 1)
    return f"assets/{stem}.{hashlib.sha256(data).hexdigest()[:10]}.{ext}"

def fingerprint_assets() -> dict[str, str]:
    mapping: dict[str, str] = {}
    def css_url(m):
        ref = m.group(2)
        if re.match(r"^(data:|https?:|#)", ref):
            return m.group(0)
        src = (ROOT / ref.lstrip("/")).resolve()
        if not src.is_file() or ROOT not in src.parents:
            raise SystemExit(f"css url() target missing: {ref}")
        rel = src.relative_to(ROOT).as_posix()
        rel = rel[len("assets/"):] if rel.startswith("assets/") else rel
        data = src.read_bytes()
        out = _hashed_name(rel, data)
        (OUT / out).parent.mkdir(parents=True, exist_ok=True)
        (OUT / out).write_bytes(data)
        mapping["/" + ref.lstrip("/")] = "/" + out
        return f'url({m.group(1)}/{out}{m.group(1)})'
    for name in FINGERPRINT:
        data = (OUT / name).read_bytes()
        if name.endswith(".css"):
            text = re.sub(r'url\((["\']?)([^)"\']+)\1\)', css_url, data.decode("utf-8"))
            data = text.encode("utf-8")
        out = _hashed_name(name, data)
        (OUT / out).parent.mkdir(parents=True, exist_ok=True)
        (OUT / out).write_bytes(data)
        mapping["/" + name] = "/" + out
    # Real product previews: hashed names (immutable content), referenced as /assets/previews/<file> by the build.
    for img in sorted(p for ext in ("*.webp", "*.avif") for p in (ROOT / "assets" / "previews").glob(ext)):
        data = img.read_bytes()
        out = _hashed_name("previews/" + img.name, data)
        (OUT / out).parent.mkdir(parents=True, exist_ok=True)
        (OUT / out).write_bytes(data)
        mapping["/assets/previews/" + img.name] = "/" + out
    # Demo video (mp4, webm, captions, poster): hashed names, referenced as /assets/video/<file> by the build.
    for f in sorted(p for ext in ("*.mp4", "*.webm", "*.vtt", "*.webp") for p in (ROOT / "assets" / "video").glob(ext)):
        data = f.read_bytes()
        out = _hashed_name("video/" + f.name.replace("-poster", "_poster"), data)
        (OUT / out).parent.mkdir(parents=True, exist_ok=True)
        (OUT / out).write_bytes(data)
        mapping["/assets/video/" + f.name] = "/" + out
    fonts = [v for k, v in mapping.items() if k.endswith(".woff2")]
    preload = "".join(f'<link rel="preload" href="{f}" as="font" type="font/woff2" crossorigin>' for f in sorted(fonts))
    for html_file in sorted(OUT.glob("*.html")):
        html = html_file.read_text(encoding="utf-8")
        for name in FINGERPRINT:
            attr = "href" if name.endswith(".css") else "src"
            html = html.replace(f'{attr}="/{name}"', f'{attr}="{mapping["/" + name]}"')
        for k, v in mapping.items():
            if k.startswith(("/assets/previews/", "/assets/video/")):
                html = html.replace(f'src="{k}"', f'src="{v}"').replace(f'srcset="{k}"', f'srcset="{v}"').replace(f'poster="{k}"', f'poster="{v}"')
        # Both themes (prefers-color-scheme, no toggle): every page declares light and dark; the browser
        # chrome follows the navy counter bar, identical in both themes.
        html = re.sub(r'<meta name="color-scheme"[^>]*>', "", html)
        html = re.sub(r'<meta name="theme-color"[^>]*>', "", html)
        html = re.sub(r'(<meta name="viewport"[^>]*>)', r'\1<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#0e1a2b">', html, count=1)
        # Self-hosted fonts (font-src 'self'), preloaded so text paints in the final face early.
        html = re.sub(r'(<link rel="stylesheet" href="/assets/(?:product|legal)\.[0-9a-f]{10}\.css">)', lambda m: preload + m.group(1), html, count=1)
        html_file.write_text(html, encoding="utf-8")
    # Unhashed font copies for the unhashed stylesheet (Worker info pages, pre-release cached HTML).
    (OUT / "assets" / "fonts").mkdir(parents=True, exist_ok=True)
    for font in sorted((ROOT / "assets" / "fonts").glob("*.woff2")):
        shutil.copy2(font, OUT / "assets" / "fonts" / font.name)
    # The unhashed copies stay published but no page loads them: /product.css serves the Worker's
    # own info pages, and all three keep working for HTML cached before this release (the old page
    # policy allowed up to 1 h of stale-while-revalidate). They are served "no-cache", never immutable.
    return mapping

def audit_asset_references() -> list[str]:
    """Published pages load only content-hashed CSS/JS that exists and matches its hash."""
    import hashlib
    problems = []
    for html_file in sorted(OUT.glob("*.html")):
        html = html_file.read_text(encoding="utf-8")
        refs = re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', html) + re.findall(r'<link\b[^>]*\brel="(?:stylesheet|preload|modulepreload)"[^>]*\bhref="([^"]+)"', html)
        for ref in refs:
            if re.match(r"^https?://", ref):
                problems.append(f"{html_file.name}: external asset {ref}")
                continue
            if not HASHED_RE.match(ref):
                problems.append(f"{html_file.name}: unhashed asset {ref}")
                continue
            f = OUT / ref.lstrip("/")
            if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()[:10] != ref.rsplit(".", 2)[1]:
                problems.append(f"{html_file.name}: hashed asset missing or stale {ref}")
        if "whatsapp-contact" in html:
            problems.append(f"{html_file.name}: references the retired contact script")
    return problems

def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for slug in HTML_ROUTES:
        copy_text_page(slug)
    write_niche_pages()

    apply_approved_overlay()

    shutil.copy2(ROOT / "product.css", OUT / "product.css")
    # Sales sitemap must match the canonical vendas domain, not the apex blog.
    # Keep the apex sitemap as-is for editorial articles.
    sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    sitemap = re.sub(r"\s*<url><loc>https://zevanory\.api\.br/</loc>.*?</url>", "", sitemap, count=1, flags=re.S)
    sitemap = re.sub(r"\s*<url><loc>https://zevanory\.api\.br/blog(?:/[^<]+)?</loc>.*?</url>", "", sitemap, flags=re.S)
    sitemap = sitemap.replace("<loc>https://zevanory.api.br/", "<loc>https://vendas.zevanory.api.br/")
    # Niche landing pages exist only on the sales domain (canonical /para/<ramo>).
    sitemap = sitemap.replace("\n</urlset>", mk.niche_sitemap_entries("2026-10-25") + "\n</urlset>", 1)
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

    # Designed 404 (served by the Worker for unknown page paths; noindex).
    nf = (ROOT / "solucoes" / "index.html").read_text(encoding="utf-8").replace("/zevanory-public-mirror/", "/")
    head_tags = re.search(r'(<link rel="icon"[^>]*>)', nf).group(1)
    header = re.search(r'(<header class="site-header">.*?</header>)', nf, re.S).group(1)
    header = header.replace(">Falar com a ZEVANORY</a>", ">Escrever para o suporte</a>").replace('<nav class="site-nav"><a ', '<nav class="site-nav" aria-label="Navegação principal"><a ', 1)
    receipt_404 = ('<div class="receipt" aria-labelledby="nf-cupom"><p class="receipt-head" id="nf-cupom">Cupom não localizado<span>404</span></p><ul>'
                   + "".join(f'<li><a class="receipt-line" href="{h}"><span class="item">{i}</span><span class="leader" aria-hidden="true"></span><span class="fix">{t}</span></a></li>'
                             for i, t, h in (("Ver tudo", "Soluções", "/solucoes"), ("Quem está por trás", "Quem criou", "/quem-criou"), ("Regras da compra", "Termos", "/termos")))
                   + '</ul></div>')
    page_404 = ('<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<meta name="robots" content="noindex"><title>Página não encontrada | ZEVANORY</title>' + head_tags +
                '<link rel="stylesheet" href="/product.css"></head><body><a class="skip-link" href="#conteudo">Ir para o conteúdo</a>' + header +
                '<main id="conteudo"><section class="container not-found"><h1>Esta página não existe.</h1>'
                '<p class="hero-copy">O endereço pode ter mudado ou ter sido digitado com um erro. Escolha por onde seguir:</p>'
                + receipt_404 + '</section>' + LEGAL_FOOTER + '</main></body></html>')
    (OUT / "404.html").write_text(page_404, encoding="utf-8")

    # Root is the solutions catalog. Keep a physical index for workers.dev previews
    # even though the worker also rewrites / to /solucoes.html.
    shutil.copy2(OUT / "solucoes.html", OUT / "index.html")
    fingerprint_assets()
    asset_problems = audit_asset_references()
    if asset_problems:
        raise SystemExit("hashed asset contract failed: " + "; ".join(asset_problems))

    sales = (OUT / "zevanory-sales.html").read_text(encoding="utf-8")
    required = (
        "<title>ZEVANORY SALES",
        'href="/solucoes"',
        "Autonomous Sales Platform",
        "SALES ASSIST",
        "SALES AUTOPILOT",
        "SALES AUTONOMOUS",
    )
    missing = [token for token in required if token not in sales]
    if missing:
        raise SystemExit(f"sales build contract missing: {missing}")
    if not re.search(r'<link rel="stylesheet" href="/assets/product\.[0-9a-f]{10}\.css">', sales):
        raise SystemExit("sales build contract missing: hashed product stylesheet")
    if "/zevanory-public-mirror/" in sales:
        raise SystemExit("sales build still contains mirror path prefix")

    # P13: politica unica em todas as superficies e grep-gate do modo fechado (NO-GO).
    p13 = policy.audit_policy(OUT, PRODUCTS) + policy.audit_contact(OUT)
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
