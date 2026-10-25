#!/usr/bin/env python3
"""Marketing pieces of the sales site (closed-sales phase), used by scripts/build_sales_public.py.

  * FAQ ("Perguntas frequentes") on /solucoes, the five product pages and Conteúdo Pronto: native
    <details>/<summary> (no script) plus schema.org FAQPage JSON-LD. JSON-LD is an inline DATA block
    (type application/ld+json): browsers never execute it, so script-src 'self' is unaffected; the
    site already ships Product/FAQPage blocks the same way and the build only allows that type inline.
  * Worked examples per priced product, always under the visible label "Exemplo fictício, para
    ilustrar", with round numbers. Steps are the product's real structure as shown in the approved
    previews (cover, one inner page, one spreadsheet crop) and the deliverable list; nothing beyond.
  * Niche landing pages /para/<ramo> (data/nichos.json), published as para-<ramo>.html.
  * Testimonials: data/depoimentos.json (empty). An entry is refused unless it carries a hashed real
    order reference, explicit written consent, dates, first name + city only, and a source. While the
    list is empty the section is not rendered at all.
  * The silent captioned demo built from the approved preview images (scripts/build_demo_video.py).

Every answer restates data/politica-unica.json, /termos or the product files. No testimonials,
customer counts, ratings, logos or results are invented; no scarcity or urgency.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import sales_policy as policy  # noqa: E402

SALES_ORIGIN = "https://vendas.zevanory.api.br"
FICT_LABEL = "Exemplo fictício, para ilustrar"
VIDEO_LABEL = "Demonstração com páginas reais do material"

PRODUCT_NAMES = {
    "ia-na-pratica": "IA na Prática", "vendas-na-pratica": "Vendas na Prática", "lucro-e-caixa": "Lucro & Caixa",
    "combo-ia-vendas": "Combo IA + Vendas", "negocio-completo": "Negócio Completo", "conteudo-pronto": "Conteúdo Pronto",
    "ferramentas": "Calculadoras grátis",
}
PRICE_LINE = {
    "ia-na-pratica": "R$ 197 · pagamento único", "vendas-na-pratica": "R$ 197 · pagamento único",
    "lucro-e-caixa": "R$ 247 · pagamento único", "combo-ia-vendas": "R$ 297 · pagamento único",
    "negocio-completo": "R$ 397 · pagamento único", "conteudo-pronto": "R$ 197 por mês", "ferramentas": "Grátis",
}


def esc(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def attr(text: str) -> str:
    return esc(text).replace('"', "&quot;")


def plain(html_text: str) -> str:
    """Visible text of an answer (for the JSON-LD copy: same words as the page)."""
    return _html.unescape(re.sub(r"<[^>]+>", "", html_text))


# ---------------------------------------------------------------------------------------------
# FAQ
# ---------------------------------------------------------------------------------------------
NICHE_LINKS = ('<a href="/para/salao">salão</a>, <a href="/para/oficina">oficina</a>, '
               '<a href="/para/clinica">clínica</a> e <a href="/para/loja">loja</a>')

# Valid in both modes (the Worker restores buy CTAs at request time without a rebuild): no claim that sales
# ARE closed and never the literal CTA label, which the open-mode tests require to disappear.
WAITLIST_A = ("Enquanto as vendas estiverem fechadas, os preços mostrados são informativos e o botão da lista de espera "
              f"abre um e-mail para {policy.SUPPORT_EMAIL} com o assunto pronto. Quando as vendas abrirem, avisamos por e-mail "
              "quem escreveu. A lista não cobra nada, não pede cadastro nem formulário e não reserva preço nem vaga.")
WAITLIST_Q = ("O que a lista de espera faz enquanto as vendas estão fechadas?", WAITLIST_A)

DELIVERY_A = ("Depois da confirmação do pagamento (Pix ou cartão, pelo Mercado Pago), chega no e-mail que você informou um "
              f"{policy.DELIVERY_72H}, com um arquivo .zip com todo o material. Se o link expirar, um novo é enviado sem custo.")
REFUND_A = (f"Você pode desistir em {policy.RULE_7D}, sem justificativa e com devolução integral. O pedido é feito em "
            '<a href="https://zevanory.api.br/pedir-reembolso">zevanory.api.br/pedir-reembolso</a> ou pelo e-mail '
            f'<a href="mailto:{policy.SUPPORT_EMAIL}">{policy.SUPPORT_EMAIL}</a>.')
FORMATS = {
    "ia-na-pratica": "Manual em PDF e em DOCX editável, guia rápido em PDF, comandos prontos em arquivo de texto e a planilha de orçamento e execução em XLSX, com um arquivo “Comece aqui”.",
    "vendas-na-pratica": "Manual em PDF e em DOCX editável, guia rápido em PDF, mensagens e roteiros de conteúdo em arquivos de texto e a planilha comercial em XLSX, com um arquivo “Comece aqui”.",
    "lucro-e-caixa": "Manual em PDF e em DOCX editável, guia rápido em PDF e DOCX, planilha de caixa e margem em XLSX, checklist semanal e comandos de IA em arquivos de texto, com um arquivo “Comece aqui”.",
    "combo-ia-vendas": "Os arquivos completos do IA na Prática e do Vendas na Prática: manuais em PDF e DOCX editável, guias rápidos em PDF, comandos, mensagens e roteiros em texto e as duas planilhas em XLSX.",
    "negocio-completo": "Os três produtos completos (manuais em PDF e DOCX, guias, comandos, mensagens e planilhas XLSX), mais o Plano integrado de 30 dias em PDF e DOCX e o Painel de decisão integrada em XLSX.",
}
SPREADSHEET = {
    "ia-na-pratica": "Não precisa ser especialista. Basta abrir um arquivo XLSX e digitar nos campos indicados; a aba Instruções e o guia rápido mostram por onde começar. O manual pede um aplicativo compatível com XLSX.",
    "vendas-na-pratica": "Não precisa ser especialista. A planilha comercial abre pela aba Instruções e cada oportunidade é uma linha. O manual pede um aplicativo compatível com XLSX; dá para praticar só com simulações.",
    "lucro-e-caixa": "Não precisa ser especialista. Você digita os seus números nas abas, na ordem que a capa do manual mostra, e confere o status da configuração antes de decidir. O guia rápido foi feito para começar em 15 minutos; a aba Exemplo é fictícia e serve para aprender.",
    "combo-ia-vendas": "Não precisa ser especialista. As duas planilhas abrem pela aba Instruções e o guia rápido de cada produto mostra o primeiro passo. É preciso um aplicativo compatível com XLSX.",
    "negocio-completo": "Não precisa ser especialista. Cada planilha tem ordem de uso, e o Plano de 30 dias pede uma tarefa curta por dia, com critério de conclusão. É preciso um aplicativo compatível com XLSX.",
}
PRODUCT_RAMO = {
    "ia-na-pratica": "Foi escrito para autônomos e pequenos prestadores de serviço que recebem pedidos de orçamento. Os exemplos são fictícios e o material não ensina serviço técnico. Veja como cada ramo usa: ",
    "vendas-na-pratica": "Foi escrito para autônomos e pequenos prestadores de serviço que atendem pelo WhatsApp e pelas redes. Os exemplos são fictícios; a aplicação se adapta ao seu ciclo de venda. Veja como cada ramo usa: ",
    "lucro-e-caixa": "Serve para quem vende produtos ou serviços: a planilha trabalha com os números que você informa, não com um ramo específico. Veja como cada ramo usa: ",
    "combo-ia-vendas": "Os dois manuais foram escritos para pequenos prestadores de serviço que recebem pedidos de orçamento e atendem pelo WhatsApp e pelas redes. Veja como cada ramo usa: ",
    "negocio-completo": "Foi pensado para negócios pequenos que querem organizar IA, vendas e caixa de uma vez. Veja como cada ramo usa: ",
}


def product_faq(slug: str, price: int) -> list[tuple[str, str]]:
    """Extra questions for a product page (the page already answers delivery and withdrawal)."""
    return [
        ("Em que formato vêm os arquivos?", FORMATS[slug] + " Tudo chega num único arquivo .zip."),
        ("Preciso saber mexer em planilha?", SPREADSHEET[slug]),
        ("Serve para o meu ramo?", PRODUCT_RAMO[slug] + NICHE_LINKS + "."),
        ("Tem mensalidade?", f"Não. É pagamento único de R$ {price}. Na ZEVANORY, só o Conteúdo Pronto é assinatura mensal."),
        WAITLIST_Q,
    ]


SUBSCRIPTION_FAQ = [
    ("Tem mensalidade?", "Sim. O Conteúdo Pronto é uma assinatura de R$ 197 por mês, cobrada pela Hotmart, sem fidelidade: a renovação pode ser cancelada a qualquer momento. Os outros produtos da ZEVANORY são pagamento único."),
    ("Como recebo?", "Depois da confirmação do pagamento, chega por e-mail o link de um formulário curto sobre o seu negócio; depois, o pacote do mês em link privado."),
    ("Serve para o meu ramo?", "O formulário curto existe para isso: os textos saem no tom do seu negócio. Veja exemplos de problemas por ramo: " + NICHE_LINKS + "."),
    ("E se eu não gostar?", f"Você pode desistir em {policy.RULE_7D}, com devolução integral dos valores pagos."),
    WAITLIST_Q,
]

SOLUCOES_FAQ = [
    WAITLIST_Q,
    ("Como recebo o produto?", DELIVERY_A),
    ("Em que formato vêm os arquivos?", "Manuais em PDF e em DOCX editável, guias rápidos, planilhas em XLSX e arquivos de texto com comandos ou mensagens, conforme o produto. Tudo chega num único arquivo .zip. Nenhum produto inclui vídeo, software, disparo automático, consultoria individual ou promessa de faturamento."),
    ("Preciso saber mexer em planilha?", "Não precisa ser especialista. As planilhas têm ordem de uso e instruções, e cada produto traz um guia rápido. É preciso um aplicativo compatível com XLSX."),
    ("Serve para o meu ramo?", "Os materiais foram escritos para pequenos negócios que vendem produtos ou serviços e atendem pelo WhatsApp e pelas redes. Veja os problemas de cada ramo e o que resolve cada um: " + NICHE_LINKS + "."),
    ("Para quem não é?", "Não substitui contador nem consultoria financeira, jurídica ou tributária, não é sistema de gestão e não inclui anúncios pagos, disparo em massa ou consultoria individual. Não há promessa de lucro, vendas ou clientes."),
    ("E se eu não gostar?", REFUND_A),
    ("Tem mensalidade?", "Só o Conteúdo Pronto, assinatura de R$ 197 por mês cobrada pela Hotmart, sem fidelidade. Lucro & Caixa, Vendas na Prática, IA na Prática, o Combo e o Negócio Completo são pagamento único."),
    ("Preciso pagar alguma ferramenta de IA?", "Os materiais de IA funcionam com a ferramenta de texto que você já usa ou autorizar. Assinaturas e custos de terceiros não estão incluídos."),
]


def faq_details(qas) -> str:
    return "".join(f"<details><summary>{esc(q) if '<' not in q else q}</summary><p>{a}</p></details>" for q, a in qas)


def faq_ld_entities(qas) -> list[dict]:
    return [{"@type": "Question", "name": plain(q), "acceptedAnswer": {"@type": "Answer", "text": plain(a)}} for q, a in qas]


def faq_section(qas, heading_id: str = "perguntas", heading: str = "Perguntas frequentes",
                lead: str = "Respostas curtas, tiradas dos termos e dos próprios arquivos.") -> str:
    return (f'<section class="container section faq-section" aria-labelledby="{heading_id}"><div class="section-head">'
            f'<h2 id="{heading_id}">{heading}</h2><p class="section-lead">{lead}</p></div>'
            f'<div class="faq">{faq_details(qas)}</div></section>')


def faq_ld_block(qas) -> str:
    data = {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faq_ld_entities(qas)}
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False) + "</script>"


def extend_faq(html: str, qas, slug: str) -> str:
    """Append questions to the page's existing FAQ (details list + FAQPage JSON-LD), skipping ones it
    already asks. The visible answer and the JSON-LD answer are the same words."""
    have = set(re.findall(r"<summary>(.*?)</summary>", html))
    new = [(q, a) for q, a in qas if q not in have]
    m = re.search(r'(<div class="faq">)(.*?)(</div>)', html, re.S)
    if not m:
        raise SystemExit(f"{slug}: FAQ container missing")
    html = html[: m.end(2)] + faq_details(new) + html[m.end(2):]

    def fix(mm):
        data = json.loads(mm.group(2))
        nodes = data.get("@graph", [data])
        faq = [n for n in nodes if n.get("@type") == "FAQPage"]
        if len(faq) != 1:
            return mm.group(0)
        faq[0]["mainEntity"] = faq[0].get("mainEntity", []) + faq_ld_entities(new)
        return mm.group(1) + json.dumps(data, ensure_ascii=False) + mm.group(3)

    before = html
    html = re.sub(r'(<script type="application/ld\+json">)(.*?)(</script>)', fix, html, flags=re.S)
    if html == before and new:
        raise SystemExit(f"{slug}: FAQPage JSON-LD missing")
    # The FAQ section heading says what it is.
    html = html.replace(">Perguntas antes de decidir</h2>", ">Perguntas frequentes</h2>", 1)
    return html


# ---------------------------------------------------------------------------------------------
# Worked examples (labelled fictional)
# ---------------------------------------------------------------------------------------------
EXAMPLES = {
    "lucro-e-caixa": {
        "titulo": "Um salão que fatura R$ 20.000 por mês",
        "intro": "Um salão fictício fatura R$ 20.000 por mês e sente que o dinheiro não sobra. Os números são os do exemplo do próprio manual (módulo 1).",
        "antes": ["Olha o extrato e conclui: “vendi 20 mil”.", "Dá desconto no pacote de fim de ano sem saber quanto da margem vai embora.", "Compra produto em quantidade porque “tem dinheiro na conta”."],
        "depois": ["Separa as quatro linhas do módulo 1: receita, contribuição, despesas fixas e caixa realizado.",
                   "Lê R$ 7.000 de contribuição contra R$ 6.500 de despesas fixas: sobram cerca de R$ 500 nesta visão, não 20 mil.",
                   "Antes de dar o desconto, testa no Simulador quanto ele pressiona a margem.",
                   "Antes da compra grande, compara compra, caixa projetado e reserva na aba Compra_Caixa, e repete a leitura toda semana com o checklist financeiro."],
        "nota": "O material não promete lucro nem economia: ele organiza a leitura dos seus números para você decidir.",
    },
    "vendas-na-pratica": {
        "titulo": "Uma oficina com 40 pedidos de orçamento por mês",
        "intro": "Uma oficina fictícia recebe cerca de 40 pedidos de orçamento por mês pelo WhatsApp.",
        "antes": ["Responde quando dá, de memória.", "Manda o preço solto (“fica R$ 800”), sem dizer o que inclui.", "Não sabe quantos pedidos ficaram sem resposta, nem de onde veio cada cliente."],
        "depois": ["Aula B1: escreve uma oferta que consegue cumprir: serviço, o que inclui, o que depende de avaliação e o próximo passo.",
                   "Aulas B4 e B5: entende o pedido antes de oferecer e apresenta a proposta com clareza, usando as mensagens adaptáveis.",
                   "Cada pedido vira uma linha na aba Oportunidades: origem, etapa, resultado, proposta e próxima ação.",
                   "Aulas B7 e B8: no fim do mês, conta quantos dos 40 estão abertos, ganhos e perdidos, e escolhe uma melhoria."],
        "nota": "O material não promete clientes nem aumento de vendas: organiza o atendimento e o acompanhamento.",
    },
    "ia-na-pratica": {
        "titulo": "Um técnico que monta 20 orçamentos por mês",
        "intro": "Um técnico de ar-condicionado fictício monta cerca de 20 orçamentos por mês a partir de mensagens de clientes.",
        "antes": ["Copia e cola orçamentos antigos e às vezes esquece um item.", "Testou IA, mas mandou um texto com prazo que ele não tinha confirmado."],
        "depois": ["Aula A1: escolhe uma rotina e mede o tempo completo. No exemplo do manual: 12 minutos à mão; com IA, 3 para preparar os dados, 1 para gerar e 5 para revisar, 9 no total.",
                   "Aulas A2 e A3: dá contexto sem expor o cliente e transforma o pedido em briefing.",
                   "Aula A4: monta o orçamento na aba Orçamento: item, quantidade, unitário, subtotal e conferência.",
                   "Aula A7: revisa antes de enviar; nenhum preço, prazo ou condição sem fonte."],
        "nota": "O próprio manual avisa: só vale se o documento final não tiver erro, e uma observação isolada não demonstra ganho recorrente.",
    },
    "combo-ia-vendas": {
        "titulo": "Uma loja que atende pelo direct e pelo WhatsApp",
        "intro": "Uma loja de roupas fictícia responde perguntas como “tem no M?” pelo direct e pelo WhatsApp.",
        "antes": ["Responde horas depois e escreve tudo do zero.", "Não anota quem pediu aviso de reposição."],
        "depois": ["IA na Prática primeiro: comandos prontos para rascunhos de respostas e descrições, sempre revisados (aulas A3 e A7).",
                   "Vendas na Prática em seguida: cada conversa vira oportunidade com próxima ação na aba Oportunidades.",
                   "Os roteiros de conteúdo e o calendário de 14 dias dão a pauta dos posts da quinzena."],
        "nota": "Os dois treinamentos funcionam de forma independente. O pacote não promete faturamento, clientes ou automação.",
    },
    "negocio-completo": {
        "titulo": "Uma clínica de estética em 30 dias",
        "intro": "Uma clínica de estética fictícia quer organizar atendimento, vendas e caixa sem largar a agenda.",
        "antes": ["Cada problema é resolvido no susto, um de cada vez.", "Não há um dia da semana para olhar números."],
        "depois": ["Semana 1 do plano: organizar a operação, uma tarefa curta por dia (mapa do negócio, briefing, orçamento revisado, rotina semanal).",
                   "Semana 2: oferta clara, objeções, mensagens, oportunidades na planilha e follow-up.",
                   "Semanas seguintes: medir e decidir, como diz a capa do plano (organizar, vender, medir, decidir).",
                   "O Painel de Decisão Integrada cruza os sinais do mesmo período para escolher o que revisar primeiro."],
        "nota": "Cada dia tem um critério de conclusão. As prioridades do painel não provam causa e não garantem resultado.",
    },
    "conteudo-pronto": {
        "titulo": "Uma loja que posta quando sobra tempo",
        "intro": "Uma loja fictícia posta só quando sobra tempo e fica semanas sem aparecer.",
        "antes": ["Abre o Instagram sem saber o que publicar.", "Escreve a mensagem de venda na hora, cada vez de um jeito."],
        "depois": ["Responde uma vez um formulário curto sobre o negócio.", "Recebe o pacote do mês por e-mail: 12 posts com legenda, chamada e hashtags, 4 mensagens de venda e o calendário de 30 dias.", "Revisa, ajusta e publica nas próprias contas."],
        "nota": "Não há garantia de vendas: o serviço entrega constância de comunicação. A ZEVANORY não publica nas suas redes.",
    },
}


def example_block(ex: dict, heading_id: str, after_label: str, heading: str | None = None) -> str:
    before = "".join(f"<li>{esc(x)}</li>" for x in ex["antes"])
    after = "".join(f"<li>{esc(x)}</li>" for x in ex["depois"])
    note = f'<p class="example-note">{esc(ex["nota"])}</p>' if ex.get("nota") else ""
    return (f'<section class="container section example" data-illustrative aria-labelledby="{heading_id}">'
            f'<div class="section-head"><p class="example-label">{FICT_LABEL}</p>'
            f'<h2 id="{heading_id}">{esc(heading or ex["titulo"])}</h2><p class="section-lead">{esc(ex["intro"])}</p></div>'
            f'<div class="example-grid"><div class="example-col example-before"><h3>Antes</h3><ul>{before}</ul></div>'
            f'<div class="example-col example-after"><h3>{esc(after_label)}</h3><ol>{after}</ol></div></div>{note}</section>')


def product_example(slug: str) -> str:
    return example_block(EXAMPLES[slug], "exemplo", "Com o " + PRODUCT_NAMES[slug])


# ---------------------------------------------------------------------------------------------
# Testimonials (structure only; empty until the owner adds a real one)
# ---------------------------------------------------------------------------------------------
DEPOIMENTOS_PATH = Path(os.environ.get("ZEVANORY_DEPOIMENTOS") or ROOT / "data" / "depoimentos.json")
DEPO_FIELDS = {"pedido_ref_sha256", "consentimento_escrito", "consentimento_data", "data", "primeiro_nome",
               "cidade", "fonte", "produto", "texto"}
DEPO_SOURCES = {"email", "formulario-atendimento", "pesquisa-pos-venda"}
DEPO_PRODUCTS = {"ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo", "conteudo-pronto"}
_NAME_RE = re.compile(r"^[A-ZÀ-Ý][a-zà-ÿ]{1,24}$")
_CITY_RE = re.compile(r"^[A-ZÀ-Ý][A-Za-zÀ-ÿ'’. -]{1,40} \((AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\)$")


def _iso_date(v) -> _dt.date | None:
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        return None
    try:
        return _dt.date.fromisoformat(v)
    except ValueError:
        return None


def validate_depoimentos(entries, today: _dt.date | None = None) -> list[str]:
    """Problems with the testimonial list (empty list = publishable). Fail-closed: anything not
    explicitly allowed is refused, including surnames, photos, ratings or extra fields."""
    today = today or _dt.date.today()
    if not isinstance(entries, list):
        return ["depoimentos: o arquivo precisa ser uma lista JSON"]
    problems, seen = [], set()
    for i, e in enumerate(entries):
        p = f"depoimento[{i}]"
        if not isinstance(e, dict):
            problems.append(f"{p}: precisa ser um objeto")
            continue
        missing = sorted(DEPO_FIELDS - set(e))
        extra = sorted(set(e) - DEPO_FIELDS)
        if missing:
            problems.append(f"{p}: faltam campos {missing}")
        if extra:
            problems.append(f"{p}: campos não permitidos {extra} (só primeiro nome e cidade; sem sobrenome, foto, nota ou contato)")
        ref = e.get("pedido_ref_sha256")
        if not (isinstance(ref, str) and re.fullmatch(r"[0-9a-f]{64}", ref)):
            problems.append(f"{p}: pedido_ref_sha256 deve ser o SHA-256 (64 hex minúsculos) da referência real do pedido")
        elif ref in seen:
            problems.append(f"{p}: o mesmo pedido aparece duas vezes")
        else:
            seen.add(ref)
        if e.get("consentimento_escrito") is not True:
            problems.append(f"{p}: consentimento_escrito precisa ser true (autorização por escrito)")
        d, c = _iso_date(e.get("data")), _iso_date(e.get("consentimento_data"))
        if d is None:
            problems.append(f"{p}: data inválida (AAAA-MM-DD)")
        if c is None:
            problems.append(f"{p}: consentimento_data inválida (AAAA-MM-DD)")
        for label, v in (("data", d), ("consentimento_data", c)):
            if v and v > today:
                problems.append(f"{p}: {label} no futuro")
        if d and c and c < d:
            problems.append(f"{p}: consentimento anterior ao depoimento")
        if not (isinstance(e.get("primeiro_nome"), str) and _NAME_RE.fullmatch(e["primeiro_nome"])):
            problems.append(f"{p}: primeiro_nome deve ser só o primeiro nome (uma palavra)")
        if not (isinstance(e.get("cidade"), str) and _CITY_RE.fullmatch(e["cidade"])):
            problems.append(f"{p}: cidade no formato 'Cidade (UF)'")
        if e.get("fonte") not in DEPO_SOURCES:
            problems.append(f"{p}: fonte deve ser uma de {sorted(DEPO_SOURCES)}")
        if e.get("produto") not in DEPO_PRODUCTS:
            problems.append(f"{p}: produto desconhecido")
        t = e.get("texto")
        if not (isinstance(t, str) and 20 <= len(t.strip()) <= 400):
            problems.append(f"{p}: texto entre 20 e 400 caracteres")
        elif re.search(r"https?://|www\.|@|\d{4,}", t):
            problems.append(f"{p}: texto sem link, e-mail ou número de contato")
    return problems


def load_depoimentos() -> list[dict]:
    entries = json.loads(DEPOIMENTOS_PATH.read_text(encoding="utf-8"))
    problems = validate_depoimentos(entries)
    if problems:
        raise SystemExit("depoimentos recusados: " + "; ".join(problems))
    return entries


MONTHS = ("janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro")


def testimonials_section(entries: list[dict], product: str | None = None) -> str:
    """Empty string while there is no real, consented testimonial (no placeholder of any kind)."""
    items = [e for e in entries if product is None or e["produto"] == product]
    if not items:
        return ""
    quotes = []
    for e in items:
        d = _dt.date.fromisoformat(e["data"])
        quotes.append(f'<figure class="depo"><blockquote><p>{esc(e["texto"].strip())}</p></blockquote>'
                      f'<figcaption>{esc(e["primeiro_nome"])}, {esc(e["cidade"])}. Cliente do {esc(PRODUCT_NAMES[e["produto"]])}, '
                      f'{MONTHS[d.month - 1]} de {d.year}.</figcaption></figure>')
    return ('<section class="container section depoimentos" id="depoimentos" aria-labelledby="depo-titulo"><div class="section-head">'
            '<h2 id="depo-titulo">O que clientes escreveram</h2><p class="section-lead">Depoimentos reais, publicados com autorização '
            'por escrito, com o primeiro nome e a cidade de quem escreveu.</p></div>'
            f'<div class="depo-list">{"".join(quotes)}</div></section>')


# ---------------------------------------------------------------------------------------------
# Demo video (silent, captioned; real approved preview pages only)
# ---------------------------------------------------------------------------------------------
VIDEO_MANIFEST = ROOT / "docs" / "evidence" / "sales-ux" / "demo-video-manifest.json"


def video_section() -> str:
    m = json.loads(VIDEO_MANIFEST.read_text(encoding="utf-8"))
    o = m["outputs"]
    script = "".join(f"<li>{esc(s['caption'])}</li>" for s in m["shots"])
    return ('<section class="container section demo" id="demonstracao" aria-labelledby="demo-titulo"><div class="section-head">'
            f'<h2 id="demo-titulo">Veja o material por dentro, em {round(m["duration_s"])} segundos</h2>'
            f'<p class="section-lead">{VIDEO_LABEL}: as mesmas capas, páginas internas e trechos de planilha mostrados em cada produto, '
            'sem som e com legendas em português.</p></div>'
            # Poster: the light typography card (~11 KB). A poster attribute is fetched with the page even with
            # preload="none"; measured, the first 40 KB poster pushed the mobile LCP of /solucoes from ~1.7 s to
            # ~2.0 s (Lighthouse 99), so the poster is the intro card, which compresses to a fraction of a page shot.
            f'<figure class="demo-figure"><video controls preload="none" playsinline muted width="{m["width"]}" height="{m["height"]}" '
            f'poster="/{o["poster"]["file"]}" aria-describedby="demo-roteiro-titulo">'
            f'<source src="/{o["webm"]["file"]}" type="video/webm"><source src="/{o["mp4"]["file"]}" type="video/mp4">'
            f'<track kind="captions" srclang="pt-BR" label="Português (Brasil)" src="/{o["vtt"]["file"]}" default></video>'
            f'<figcaption><span class="inside-label">{VIDEO_LABEL}</span></figcaption></figure>'
            f'<details class="demo-script"><summary id="demo-roteiro-titulo">Ler o roteiro da demonstração</summary><ol>{script}</ol></details>'
            '</section>')


# ---------------------------------------------------------------------------------------------
# Free lead magnets (primary no-cost action while sales are closed)
# ---------------------------------------------------------------------------------------------
FREE_FOOTER = ('<section class="fl-block fl-free" aria-labelledby="fl-gratis"><h2 class="fl-title" id="fl-gratis">Comece grátis</h2><ul>'
               '<li><a href="/material-gratuito">Checklist de 15 minutos por dia</a></li>'
               '<li><a href="/ferramentas">Calculadoras de preço, margem e caixa</a></li>'
               '<li><a href="/ia-por-ramo">IA por ramo: guias grátis</a></li></ul></section>')

FREE_PRODUCT_LINE = ('<p class="free-next">Comece sem pagar: <a href="/material-gratuito">checklist grátis</a> '
                     'ou <a href="/ferramentas">calculadoras grátis</a>.</p>')


# ---------------------------------------------------------------------------------------------
# Niche landing pages
# ---------------------------------------------------------------------------------------------
NICHES = json.loads((ROOT / "data" / "nichos.json").read_text(encoding="utf-8"))["nichos"]
NICHE_PAGES = tuple("para-" + n["slug"] for n in NICHES)
NICHE_PATHS = {"para-" + n["slug"]: "para/" + n["slug"] for n in NICHES}


def niche_faq(n: dict) -> list[tuple[str, str]]:
    return [tuple(q) for q in n["faq"]] + [
        ("Preciso saber mexer em planilha?", "Não precisa ser especialista. As planilhas têm ordem de uso e instruções, e cada produto traz um guia rápido. É preciso um aplicativo compatível com XLSX."),
        ("Como recebo o produto?", DELIVERY_A),
        ("E se eu não gostar?", REFUND_A),
        WAITLIST_Q,
    ]


def _price_slug(slug: str) -> str:
    return PRICE_LINE.get(slug, "")


def niche_page(n: dict, header: str, footer: str, head_extra: str, waitlist_cta, how_to_buy_html: str, trust_html: str, mode_text) -> str:
    """One genuinely specific page per niche: the niche's pains in its words, which product handles
    each one (link + what in the product does it), free resources for the niche, a labelled fictional
    example, the trust block, an FAQ subset and the waiting-list CTA."""
    slug = "para-" + n["slug"]
    url = f"{SALES_ORIGIN}/para/{n['slug']}"
    lines = []
    for i, d in enumerate(n["dores"]):
        lines.append(f'<li><a class="receipt-line" href="#dor-{i + 1}"><span class="item">{esc(d["item"])}</span>'
                     f'<span class="leader" aria-hidden="true"></span><span class="fix">{esc(PRODUCT_NAMES[d["produto"]])}</span></a></li>')
    receipt = (f'<div class="receipt" aria-labelledby="cupom-{n["slug"]}"><p class="receipt-head" id="cupom-{n["slug"]}">{esc(n["cupom"])}'
               '<span>e o que resolve</span></p><ol>' + "".join(lines) + '</ol><div class="receipt-total">'
               '<a class="receipt-line" href="/negocio-completo"><span class="item">Tudo de uma vez</span>'
               '<span class="leader" aria-hidden="true"></span><span class="fix">Negócio Completo</span></a></div></div>')
    hero = (f'<section class="container hero niche-hero"><div><p class="kicker">{esc(n["kicker"])}</p><h1>{esc(n["h1"])}</h1>'
            f'<p class="hero-copy">{esc(n["lead"])}</p>'
            '<div class="hero-actions"><a class="button primary key" href="/material-gratuito">Ver o checklist grátis de 15 minutos</a>'
            '<a class="button secondary" href="/ferramentas">Usar as calculadoras grátis</a></div>'
            '<p class="byline">Grátis e sem cartão. Feito por <a href="/quem-criou">Renan Bitu</a>, em Várzea Alegre (CE).</p></div>'
            f'{receipt}</section>')
    cards = []
    for i, d in enumerate(n["dores"]):
        p = d["produto"]
        cards.append(f'<article class="pain-card" id="dor-{i + 1}" tabindex="-1"><h3>{esc(d["item"])}</h3>'
                     f'<p>{esc(d["detalhe"])}</p><p class="pain-fix"><a href="/{p}">{esc(PRODUCT_NAMES[p])}</a>'
                     f'<span>{esc(_price_slug(p))}</span></p></article>')
    pains = ('<section class="container section" aria-labelledby="o-que-resolve"><div class="section-head">'
             f'<h2 id="o-que-resolve">O que resolve cada problema</h2><p class="section-lead">Cada problema do cupom, com o material que trata dele e o que, '
             'dentro do material, faz o trabalho. Nada aqui promete resultado: o método organiza; quem decide é você.</p></div>'
             f'<div class="pain-grid">{"".join(cards)}</div>'
             + (f'<p class="niche-warning">{esc(n["aviso"])}</p>' if n.get("aviso") else "") + '</section>')
    free = "".join(f'<li><a href="{g["href"]}">{esc(g["nome"])}</a><span>{esc(g["texto"])}</span></li>' for g in n["gratis"])
    free_html = ('<section class="container section free-section" aria-labelledby="gratis"><div class="section-head">'
                 '<h2 id="gratis">Para usar hoje, sem pagar</h2>'
                 + mode_text("Enquanto as vendas estão fechadas, estes materiais são grátis e não pedem cartão.",
                             "Estes materiais são grátis e não pedem cartão.", "p", "section-lead") + '</div>'
                 f'<ul class="free-list">{free}<li><a href="/material-gratuito">Checklist de 15 minutos por dia</a>'
                 '<span>Caixa, vendas e IA em três blocos de cinco minutos.</span></li></ul></section>')
    ex = n["exemplo"]
    example = example_block({**ex, "nota": "Os números são redondos e inventados para mostrar o raciocínio. Não são resultado de cliente."},
                            "exemplo", "Com o método")
    cta = ('<section class="container final-cta niche-cta"><div class="final-box">'
           '<h2>Para resolver tudo de uma vez</h2>'
           + mode_text("O Negócio Completo junta IA na Prática, Vendas na Prática e Lucro &amp; Caixa, com o plano integrado de 30 dias. "
                       "As vendas estão fechadas: entre na lista de espera e avisamos por e-mail quando abrir.",
                       "O Negócio Completo junta IA na Prática, Vendas na Prática e Lucro & Caixa, com o plano integrado de 30 dias.", "p")
           + f'<div class="hero-actions">{waitlist_cta}<a class="button secondary" href="/solucoes">Ver todos os produtos</a></div></div></section>')
    faq = faq_section(niche_faq(n), lead=f"As dúvidas mais comuns de quem toca {esc(n['nome'])}.")
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "@id": url, "url": url, "name": n["titulo"], "description": n["descricao"], "inLanguage": "pt-BR",
         "isPartOf": {"@id": f"{SALES_ORIGIN}/#site"}},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Soluções", "item": f"{SALES_ORIGIN}/solucoes"},
            {"@type": "ListItem", "position": 2, "name": n["kicker"], "item": url}]},
        {"@type": "FAQPage", "mainEntity": faq_ld_entities(niche_faq(n))}]}
    head = ('<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{esc(n["titulo"])}</title><meta name="description" content="{attr(n["descricao"])}">'
            f'<link rel="canonical" href="{url}"><meta property="og:type" content="website"><meta property="og:title" content="{attr(n["titulo"])}">'
            f'<meta property="og:description" content="{attr(n["descricao"])}"><meta property="og:url" content="{url}">'
            f'<meta property="og:image" content="{SALES_ORIGIN}/brand/export/link-card.png">{head_extra}'
            '<link rel="stylesheet" href="/product.css">'
            f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script></head>')
    body = ('<body><a class="skip-link" href="#conteudo">Ir para o conteúdo</a>' + header + '<main id="conteudo">'
            + hero + pains + free_html + example + how_to_buy_html + faq + cta + '</main>' + footer + '</body></html>')
    return head + body


def niche_sitemap_entries(lastmod: str) -> str:
    return "".join(f"\n  <url><loc>{SALES_ORIGIN}/para/{n['slug']}</loc><lastmod>{lastmod}</lastmod>"
                   "<changefreq>monthly</changefreq><priority>0.8</priority></url>" for n in NICHES)


def niche_catalog_group() -> str:
    """'Por ramo' group on /solucoes: links to the four niche pages."""
    items = "".join(f'<li><a href="/para/{n["slug"]}">{esc(n["kicker"])}</a></li>' for n in NICHES)
    return ('<section class="container niche-links" aria-labelledby="por-ramo"><h2 id="por-ramo">Por ramo</h2>'
            '<p>Os problemas de cada tipo de negócio, nas palavras de quem toca o balcão, e o que resolve cada um.</p>'
            f'<ul class="niche-list">{items}</ul></section>')


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="ZEVANORY marketing checks")
    ap.add_argument("--check-depoimentos", metavar="PATH")
    args = ap.parse_args(argv)
    if args.check_depoimentos:
        entries = json.loads(Path(args.check_depoimentos).read_text(encoding="utf-8"))
        problems = validate_depoimentos(entries)
        for p in problems:
            print("DEPOIMENTO_RECUSADO " + p)
        print("DEPOIMENTOS=" + ("FAIL" if problems else f"PASS ({len(entries)})"))
        return 1 if problems else 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
