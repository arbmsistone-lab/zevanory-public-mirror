#!/usr/bin/env python3
"""P13 (Ordem 079-P13 / 076-P24): politica unica de compra + modo NO-GO das paginas de venda.

Fonte unica de verdade, no build estatico, para:
  * o texto unico da politica (Sol 079-P13, copiado sem alteracao; sujeito a revisao juridica do
    proprietario), a regra unica dos 7 dias e a divulgacao "72 horas / um download";
  * o modo comercial do HTML estatico.

Modo comercial: o estado real de vendas e o interruptor do proprietario (KV `sales:open:v1`,
registro "LIBERAR VENDAS" + preflight verde, worker/sales-control.mjs), lido em producao por
GET /api/sales/status (fail-closed). O HTML estatico e SEMPRE gerado fechado (sem link de checkout,
sem Offer InStock); quando o interruptor abre, o Worker publico (worker/sales-public-worker.mjs,
openSalesHtml) restaura os CTAs e a Offer em tempo de execucao, sem rebuild e sem apagar paginas.
O modo "open" do build existe so para preview/teste e nunca e usado no deploy (o workflow de
release fixa ZEVANORY_SALES_PUBLIC_MODE=closed e roda o grep-gate).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

MODE_ENV = "ZEVANORY_SALES_PUBLIC_MODE"
CLOSED = "closed"
OPEN = "open"

_DATA = json.loads((Path(__file__).resolve().parents[1] / "data" / "politica-unica.json").read_text(encoding="utf-8"))
SOL_TEXT = _DATA["sol_text"]
# Trechos exatos do texto unico, exigidos em toda superficie de politica (termos, reembolso e as
# cinco paginas de produto).
RULE_7D = _DATA["rule_7d"]
DELIVERY_72H = _DATA["delivery_72h"]
CLOSED_LABEL = _DATA["closed_label"]
WAITLIST_LABEL = _DATA["waitlist_label"]
POLICY_ANCHOR = _DATA["policy_anchor"]
# Formulacoes antigas e divergentes que nao podem voltar (achados 2, 3 e 4 do Sol).
BANNED_POLICY_PHRASES = tuple(_DATA["banned_policy_phrases"])
LEGAL_SURFACES = tuple(_DATA["policy_surfaces"]["legal"])
PRODUCT_SURFACES = tuple(_DATA["policy_surfaces"]["products"])
SUBSCRIPTION_SURFACES = tuple(_DATA["policy_surfaces"].get("subscription", ()))
CHECKOUT_HREF_PATHS = tuple(_DATA["checkout_href_paths"])
CHECKOUT_HOSTS = tuple(_DATA["checkout_hosts"])

# Decreto 7.962/2013, art. 2o: dados do "Resumo da oferta" (fonte unica, data/politica-unica.json).
RESUMO_OFERTA = _DATA["resumo_oferta"]
CUSTOMER_RULE_7D = _DATA["customer_wording"]["rule_7d"]
SUPPLIER = RESUMO_OFERTA["fornecedor"]
ADDRESS_FULL = f'{SUPPLIER["endereco_fisico"]}, CEP {SUPPLIER["cep"]}'
PENDING_MARKERS = ("PENDENTE", "PREENCHER", "A CONFIRMAR", "XXX", "PLACEHOLDER")

for _part in (RULE_7D, DELIVERY_72H):
    assert _part in SOL_TEXT, _part

# Contato publico (data/politica-unica.json, contato_publico). A conta WhatsApp Business da ZEVANORY
# foi desativada permanentemente pela Meta (2026-10-10) e o numero esta banido: o unico endereco
# eletronico oficial e o e-mail. Lista de espera e "falar com a ZEVANORY" abrem mailto com assunto/corpo
# fixos, e nenhuma superficie publica tem link ou numero de WhatsApp. A flag e uma trava: so volta com
# decisao explicita do proprietario e um NOVO numero (whatsapp_e164), nunca um de numeros_banidos.
CONTACT = _DATA["contato_publico"]
WHATSAPP_PUBLIC_LINKS_ENABLED = CONTACT["whatsapp_public_links_enabled"] is True
SUPPORT_EMAIL = CONTACT["email"]
BANNED_NUMBERS = tuple(CONTACT.get("numeros_banidos", ()))
WHATSAPP_E164 = str(CONTACT.get("whatsapp_e164") or "") if WHATSAPP_PUBLIC_LINKS_ENABLED else ""
if WHATSAPP_PUBLIC_LINKS_ENABLED and (not re.fullmatch(r"\d{12,13}", WHATSAPP_E164) or WHATSAPP_E164 in BANNED_NUMBERS):
    raise SystemExit("contato_publico: whatsapp_public_links_enabled=true exige whatsapp_e164 novo (nao banido)")
WHATSAPP_URL = "https://wa.me/" + WHATSAPP_E164 if WHATSAPP_E164 else ""
WHATSAPP_DISPLAY = str(CONTACT.get("whatsapp_display") or WHATSAPP_E164)


def _q(text: str) -> str:
    from urllib.parse import quote
    return quote(text, safe="")


def mailto(subject: str, body: str | None = None) -> str:
    """mailto com assunto (e corpo) fixos; texto estatico, sem dado pessoal."""
    href = f"mailto:{SUPPORT_EMAIL}?subject={_q(subject)}"
    return href + (f"&body={_q(body)}" if body else "")


def waitlist_href(product: str) -> str:
    """Destino do CTA 'Entrar na lista de espera' com vendas fechadas."""
    if WHATSAPP_PUBLIC_LINKS_ENABLED:
        return WHATSAPP_URL + "?text=" + _q("Olá! Quero entrar na lista de espera do " + product + ".")
    return mailto(CONTACT["waitlist_subject"].replace("{produto}", product),
                  CONTACT["waitlist_body"].replace("{produto}", product))


def contact_href() -> str:
    """Destino de 'Falar com a ZEVANORY' (nav) e do contato humano."""
    return WHATSAPP_URL if WHATSAPP_PUBLIC_LINKS_ENABLED else mailto(CONTACT["contact_subject"])


def _number_pattern(e164: str) -> str:
    """5588992545413 -> 5588992545413|99254[-\\s.]?5413 (completo ou na mascara local)."""
    local = e164[4:]
    return re.escape(e164) + "|" + re.escape(local[:-4]) + r"[-\s.]?" + re.escape(local[-4:])


# Numero banido: proibido sempre, com a flag ligada ou nao.
BANNED_NUMBER_RE = re.compile("|".join(_number_pattern(n) for n in BANNED_NUMBERS) or r"(?!)")
# Qualquer link de WhatsApp (wa.me / api.whatsapp.com / whatsapp://) ou numero banido.
WHATSAPP_PUBLIC_RE = re.compile(r"wa\.me/|api\.whatsapp\.com/|whatsapp://|" + BANNED_NUMBER_RE.pattern, re.I)


# Sem telefone publico: a ZEVANORY nao tem linha telefonica de atendimento (o unico numero foi banido).
PHONE_PUBLIC_RE = re.compile(r'"telephone"\s*:|\b(?:itemprop|property)\s*=\s*["\']?(?:schema:)?telephone\b|href\s*=\s*["\']?tel:', re.I)


def audit_contact(out_dir: Path) -> list[str]:
    """Flag desligada: zero link de WhatsApp e zero numero banido em HTML, JS e textos publicados.
    Flag ligada: o numero banido continua proibido. Sempre: nenhum telefone publico (JSON-LD/Microdata/
    RDFa telephone, href tel:) e o e-mail oficial no rodape de toda pagina."""
    rx = BANNED_NUMBER_RE if WHATSAPP_PUBLIC_LINKS_ENABLED else WHATSAPP_PUBLIC_RE
    problems = []
    for f in sorted(p for ext in ("*.html", "*.js", "*.txt", "*.xml") for p in out_dir.glob(ext)):
        text = f.read_text(encoding="utf-8")
        m = rx.search(text)
        if m:
            problems.append(f"{f.name}: WhatsApp publico ({m.group(0)}) com whatsapp_public_links_enabled={str(WHATSAPP_PUBLIC_LINKS_ENABLED).lower()}")
        m = PHONE_PUBLIC_RE.search(text)
        if m:
            problems.append(f"{f.name}: telefone publico ({m.group(0)}) sem canal telefonico oficial")
        if f.suffix == ".html" and f'href="mailto:{SUPPORT_EMAIL}"' not in text:
            problems.append(f"{f.name}: e-mail oficial {SUPPORT_EMAIL} ausente")
    return problems

SUBSCRIPTION_SUMMARY = (
    '<p class="policy-summary">Entrega: após a confirmação do pagamento, por e-mail (formulário curto e, depois, o pacote do mês em link privado). '
    f'Arrependimento: {RULE_7D}, com devolução integral (se as datas forem diferentes, vale a mais recente). '
    'Sem fidelidade: a renovação pode ser cancelada a qualquer momento. '
    f'<a href="/termos#{POLICY_ANCHOR}">Termos completos</a> · <a href="/reembolso">Reembolso</a></p>'
)

POLICY_SUMMARY = (
    f'<p class="policy-summary">Entrega: após a confirmação do pagamento, por e-mail, em {DELIVERY_72H}; '
    'se o link expirar, um novo é enviado sem custo pelo suporte. '
    f'Arrependimento: {RULE_7D}, com devolução integral (se as datas forem diferentes, vale a mais recente). '
    f'<a href="/termos#{POLICY_ANCHOR}">Termos completos</a> · <a href="/reembolso">Reembolso</a></p>'
)


def build_mode() -> str:
    """Modo do HTML estatico. Padrao fechado; qualquer valor desconhecido falha (nunca abre)."""
    raw = os.environ.get(MODE_ENV, CLOSED).strip().lower() or CLOSED
    if raw not in (CLOSED, OPEN):
        raise SystemExit(f"{MODE_ENV} invalido: {raw!r} (use closed|open)")
    return raw


_ALT = "|".join([re.escape(p) for p in CHECKOUT_HREF_PATHS] + [re.escape(h) for h in CHECKOUT_HOSTS])
# Qualquer href (relativo ou absoluto) para caminho/host de checkout ou assinatura.
CHECKOUT_HREF_RE = re.compile(r"""href\s*=\s*["']?[^"'\s>]*(?:""" + _ALT + ")", re.I)
INSTOCK_RE = re.compile(r"schema\.org/InStock", re.I)


# Qualquer <script type="application/ld+json"...> (inclusive com parametros, ex. charset).
LD_RE = re.compile(r'<script\b[^>]*\btype\s*=\s*["\']?\s*application/ld\+json[^>]*>(.*?)</script>', re.I | re.S)
OFFER_TYPES = {"offer", "aggregateoffer"}
# AVAL (Sol, 9a0f1eb): @type em forma de IRI completa, prefixo schema: ou array tambem e Offer.
_TYPE_PREFIX_RE = re.compile(r'^(?:https?://(?:www\.)?schema\.org/|schema:)', re.I)
# Microdata (itemtype) e RDFa (typeof, com ou sem vocab/prefixo) de Offer/AggregateOffer.
MICRODATA_OFFER_RE = re.compile(r'\bitemtype\s*=\s*["\']?[^"\'>]*?(?:https?://(?:www\.)?schema\.org/|schema:)?(?:Aggregate)?Offer\b', re.I)
# Oferta sem tipo explicito, pendurada na propriedade "offers" (itemprop ou property RDFa).
OFFERS_PROP_RE = re.compile(r'\b(?:itemprop|property)\s*=\s*["\']?[^"\'>]*?\b(?:schema:)?offers\b', re.I)
RDFA_OFFER_RE = re.compile(r'\btypeof\s*=\s*["\']?[^"\'>]*?\b(?:https?://(?:www\.)?schema\.org/|schema:)?(?:Aggregate)?Offer\b', re.I)
PRICE_KEYS = ("price", "lowPrice", "highPrice")


def normalize_type(value) -> str:
    """'https://schema.org/Offer', 'http://schema.org/Offer/', 'schema:Offer', 'Offer', 'offer' -> 'offer'."""
    return _TYPE_PREFIX_RE.sub("", str(value).strip()).rstrip("/").lower()


def _types(node: dict) -> set[str]:
    t = node.get("@type", node.get("type"))
    return {normalize_type(x) for x in (t if isinstance(t, list) else [t]) if x}


def _offers(node, under_offers: bool = False):
    """Todos os nos Offer/AggregateOffer (inclusive aninhados e os sem @type sob a chave "offers")."""
    if isinstance(node, list):
        for x in node:
            yield from _offers(x, under_offers)
    elif isinstance(node, dict):
        if _types(node) & OFFER_TYPES or (under_offers and not node.get("@type")):
            yield node
        for k, v in node.items():
            yield from _offers(v, k == "offers")


# AVAL (Sol, 2ff8678, FALSE_PASS por alias de @context): o gate NAO expande JSON-LD. Regra fail-closed:
# um bloco JSON-LD so e analisado se usar exclusivamente o vocabulario schema.org na forma que o
# normalizador entende; qualquer outra forma reprova o bloco INTEIRO, haja ou nao oferta nele (sem
# expansao nao da para provar a ausencia de oferta paga). Reprovam:
#   * @context ausente no topo, ou qualquer @context (topo ou aninhado) que nao seja a string schema.org
#     (http/https, com ou sem barra final) ou lista so dessas strings: contexto-objeto (definicao de
#     termo, alias de palavra-chave como "t": "@type", @vocab, prefixos, contexto com escopo), URL
#     remota diferente de schema.org, null (reset de contexto);
#   * palavra-chave fora de @context/@type/@id/@graph (@reverse, @included, @nest, @list, @set, @value,
#     @language, @json, grafias como "@Type" etc.);
#   * chave em forma de IRI ou termo compacto ("schema:offers", "http://schema.org/price", "s:x");
#   * @type em IRI/termo compacto de outro vocabulario ("s:Offer", "gr:Offering", "urn:x");
#   * chave duplicada no mesmo objeto (o parser do buscador pode ficar com o outro valor);
#   * "offers" com valor escalar (referencia a oferta que o gate nao ve).
# Pagina com JSON-LD fora dessa forma precisa ser reescrita com @context "https://schema.org".
SCHEMA_CONTEXTS = {"https://schema.org", "http://schema.org"}
ALLOWED_LD_KEYWORDS = {"@context", "@type", "@id", "@graph"}


def _context_ok(ctx) -> bool:
    if isinstance(ctx, str):
        return ctx.rstrip("/") in SCHEMA_CONTEXTS and ctx.count("/") <= 3
    if isinstance(ctx, list):
        return bool(ctx) and all(isinstance(c, str) and _context_ok(c) for c in ctx)
    return False


def _no_duplicate_keys(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise ValueError(f"chave duplicada {k!r}")
        seen[k] = v
    return seen


def ld_unsupported(data) -> str | None:
    """Motivo pelo qual o bloco JSON-LD nao pode ser provado sem expansao (None = forma suportada)."""
    tops = data if isinstance(data, list) else [data]
    if not tops:
        return "bloco vazio"
    for top in tops:
        if not isinstance(top, dict) or "@context" not in top:
            return "@context ausente no topo"

    def walk(node, path):
        if isinstance(node, list):
            for i, x in enumerate(node):
                r = walk(x, f"{path}[{i}]")
                if r:
                    return r
            return None
        if not isinstance(node, dict):
            return None
        for k, v in node.items():
            here = f"{path}.{k}"
            if k == "@context":
                if not _context_ok(v):
                    return f"@context nao suportado em {path or '$'}: {json.dumps(v, ensure_ascii=False)[:80]}"
                continue
            if k.startswith("@") and k not in ALLOWED_LD_KEYWORDS:
                return f"palavra-chave {k} nao suportada em {path or '$'}"
            if ":" in k or "/" in k:
                return f"chave em forma de IRI/termo compacto {k!r} em {path or '$'}"
            if k in ("@type", "type"):
                for t in (v if isinstance(v, list) else [v]):
                    if not isinstance(t, str):
                        return f"@type nao textual em {here}"
                    if (":" in t or "/" in t) and not _TYPE_PREFIX_RE.match(t.strip()):
                        return f"@type de outro vocabulario {t!r} em {here}"
            if k == "offers":
                for o in (v if isinstance(v, list) else [v]):
                    if not isinstance(o, dict):
                        return f"offers com valor escalar em {here}"
            r = walk(v, here)
            if r:
                return r
        return None

    return walk(data, "")


def _price_values(offer: dict) -> list:
    vals = [offer.get(k) for k in PRICE_KEYS if offer.get(k) not in (None, "")]
    spec = offer.get("priceSpecification")
    for sp in (spec if isinstance(spec, list) else [spec]):
        if isinstance(sp, dict) and sp.get("price") not in (None, ""):
            vals.append(sp["price"])
    return vals


def paid_offer(offer: dict) -> bool:
    """Oferta paga = qualquer preco > 0, ou preco ausente/ilegivel (fail-closed). So preco 0 explicito
    (calculadoras gratuitas) e livre. A disponibilidade nao importa: InStock, PreOrder, PreSale,
    LimitedAvailability ou nenhuma, tudo e anuncio de venda."""
    vals = _price_values(offer)
    if not vals:
        return True
    for v in vals:
        try:
            if float(str(v).replace("R$", "").replace(",", ".").strip()) != 0:
                return True
        except ValueError:
            return True
    return False


def audit_closed(out_dir: Path) -> list[str]:
    """Gate do modo fechado (AVAL 084): em qualquer HTML publicado, zero href de checkout/assinatura
    (/comprar/, /assinar/, /hotmart/, pay.hotmart.com e outros checkouts externos), zero Offer paga
    em JSON-LD (qualquer disponibilidade, inclusive PreOrder/PreSale ou sem availability), zero Offer
    em microdata e zero schema.org/InStock. JSON-LD ilegivel tambem falha (nao da para provar)."""
    problems = []
    for f in sorted(out_dir.glob("*.html")):
        text = f.read_text(encoding="utf-8")
        if CHECKOUT_HREF_RE.search(text):
            problems.append(f"{f.name}: href de checkout/assinatura ({CHECKOUT_HREF_RE.search(text).group(0)[-40:]}) em modo fechado")
        if INSTOCK_RE.search(text):
            problems.append(f"{f.name}: schema.org/InStock em modo fechado")
        # Microdata/RDFa: qualquer Offer reprova em modo fechado (as gratuitas usam so JSON-LD com preco 0).
        if MICRODATA_OFFER_RE.search(text):
            problems.append(f"{f.name}: Offer em microdata em modo fechado")
        if RDFA_OFFER_RE.search(text):
            problems.append(f"{f.name}: Offer em RDFa em modo fechado")
        if OFFERS_PROP_RE.search(text):
            problems.append(f"{f.name}: propriedade offers (microdata/RDFa) em modo fechado")
        for block in LD_RE.findall(text):
            try:
                data = json.loads(block, object_pairs_hook=_no_duplicate_keys)
            except (ValueError, RecursionError):
                problems.append(f"{f.name}: JSON-LD ilegivel (nao da para provar ausencia de oferta paga)")
                continue
            why = ld_unsupported(data)
            if why:
                problems.append(f"{f.name}: JSON-LD fora da forma suportada ({why}); sem expansao nao da para provar ausencia de oferta paga")
                continue
            for offer in _offers(data):
                if paid_offer(offer):
                    problems.append(f"{f.name}: Offer paga em modo fechado (price={offer.get('price')!r}, availability={offer.get('availability')!r})")
    return problems


def audit_policy(out_dir: Path, products=PRODUCT_SURFACES, legal=LEGAL_SURFACES) -> list[str]:
    """Mesma regra de 7 dias e mesma divulgacao 72 h / um download em todas as superficies."""
    problems = []
    for slug in tuple(legal) + tuple(products):
        text = (out_dir / f"{slug}.html").read_text(encoding="utf-8")
        for need in (RULE_7D, DELIVERY_72H):
            if need not in text:
                problems.append(f"{slug}: falta '{need}'")
        for bad in BANNED_POLICY_PHRASES:
            if bad in text:
                problems.append(f"{slug}: formulacao divergente '{bad}'")
    for slug in SUBSCRIPTION_SURFACES:
        text = (out_dir / f"{slug}.html").read_text(encoding="utf-8")
        if RULE_7D not in text:
            problems.append(f"{slug}: falta '{RULE_7D}'")
        if f"/termos#{POLICY_ANCHOR}" not in text:
            problems.append(f"{slug}: falta o resumo da politica junto ao CTA")
    # Nenhuma pagina publicada pode manter formulacao divergente (calculadoras, catalogo, kit etc.).
    checked = set(legal) | set(products) | set(SUBSCRIPTION_SURFACES)
    for f in sorted(out_dir.glob("*.html")):
        if f.stem in checked:
            continue
        text = f.read_text(encoding="utf-8")
        for bad in BANNED_POLICY_PHRASES:
            if bad in text:
                problems.append(f"{f.stem}: formulacao divergente '{bad}'")
    for slug in legal:
        text = (out_dir / f"{slug}.html").read_text(encoding="utf-8")
        if SOL_TEXT not in text:
            problems.append(f"{slug}: texto unico (Sol 079-P13) ausente ou alterado")
    return problems


def main(argv=None) -> int:
    """CLI: python3 scripts/sales_policy.py --audit <dir> [--mode closed|open]."""
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit", required=True)
    ap.add_argument("--mode", choices=(CLOSED, OPEN), default=CLOSED)
    a = ap.parse_args(argv)
    out = Path(a.audit)
    problems = audit_policy(out) + audit_contact(out)
    if a.mode == CLOSED:
        problems += audit_closed(out)
    for p in problems:
        print("P13_FAIL " + p)
    print("P13_AUDIT=" + ("FAIL" if problems else "PASS") + " mode=" + a.mode)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
