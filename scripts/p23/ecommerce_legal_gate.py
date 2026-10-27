#!/usr/bin/env python3
"""P23 Fiscal e consumidor: gate de CI do comércio eletrônico (Roteiro Mestre v4.7, seções 5 e 7/F3).

Parte coberta: só a conformidade do comércio eletrônico e a trava fiscal no código. O enquadramento tributário é decisão
de classe D do proprietário com o contador (frente de 26/10/2026) e NÃO é decidido aqui.

Normas (citadas item a item em data/p23/ecommerce-legal-checklist.json):
  Decreto 7.962/2013 (https://planalto.gov.br/ccivil_03/_Ato2011-2014/2013/Decreto/D7962.htm), arts. 2º, 4º e 5º;
  Lei 8.078/1990, CDC (https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm), arts. 31 e 49.

Reprova (exit 1) quando:
  - uma página publicada do site de vendas (sales-public/*.html) mostra preço sem identificar o fornecedor (razão social,
    CNPJ, endereço físico com CEP, e-mail) ou sem link para os termos e para o reembolso (art. 2º, I e II; art. 5º);
  - uma página de oferta paga não tem o "Resumo da oferta" completo (art. 2º, I a VI), tem marcador de pendência,
    diverge do catálogo no preço (CDC art. 31), não informa ausência de taxas adicionais (art. 2º, IV) ou não informa
    o arrependimento de 7 dias com devolução integral (CDC art. 49; art. 5º);
  - os termos ou a política de reembolso perdem uma das declarações dos arts. 4º e 5º;
  - os dados do fornecedor são inválidos (dígitos do CNPJ, formato do CEP, campo vazio ou pendente);
  - a trava "Nenhuma venda direta pelo checkout próprio antes do processo fiscal definido" some do código (sinal
    'fiscal' do portão de checkout, status público) ou o registro fiscal está DEFINIDO sem todos os campos.
Achados que não dependem de código (checkout só provável com pedido de teste, dado a confirmar pelo proprietário,
páginas-fonte fora do site de vendas) saem como FINDING, sem inventar dado.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

PENDING = re.compile(r"PENDENTE|PREENCHER|A CONFIRMAR|XXX|PLACEHOLDER|\bTODO\b")  # maiúsculas: "Todo mês" é texto legítimo
PRICE = re.compile(r"R\$\s?\d")
RESUMO_FIELDS = ("fornecedor", "cnpj", "endereco_fisico", "endereco_eletronico", "caracteristicas", "preco_total",
                 "pagamento", "disponibilidade", "entrega", "restricoes", "arrependimento")
# Declarações exigidas nos termos e na política de reembolso (trechos do texto único data/politica-unica.json).
DECLARATIONS = {
    "D7962-4-II": "O consumidor poderá corrigir os dados do pedido antes de concluir a compra",
    "D7962-4-III": "receberá imediatamente a confirmação",
    "D7962-4-IV": "uma cópia conservável destes termos",
    "D7962-4-PU": "resposta conclusiva em até 5 dias",
    "D7962-5-1": "pela mesma ferramenta usada na contratação",
    "D7962-5-2": "Contratos acessórios serão cancelados sem custo",
    "D7962-5-3": "comunicará imediatamente o Mercado Pago para impedir o lançamento ou iniciar o estorno",
    "D7962-5-4": "O recebimento do pedido será confirmado imediatamente",
    "CDC-49": "no prazo de 7 dias corridos contados da assinatura do contrato ou do recebimento do produto ou serviço",
    "CDC-49-PU": "os valores pagos serão devolvidos integralmente",
}
LEGAL_PAGES = ("termos", "reembolso")
FISCAL_FIELDS = ("regime", "documento_fiscal", "emissor", "decided_by", "accountant_ref", "decided_at", "procedure_ref",
                 "test_order_ref", "owner_approval_ref")


def visible(raw: str) -> str:
    s = re.sub(r"<script\b.*?</script>|<style\b.*?</style>", " ", raw, flags=re.S | re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s).strip()


def cnpj_valid(cnpj: str) -> bool:
    d = re.sub(r"\D", "", cnpj or "")
    if len(d) != 14 or len(set(d)) == 1:
        return False
    nums = [int(c) for c in d]
    for size, weights in ((12, (5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)), (13, (6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2))):
        r = sum(n * w for n, w in zip(nums[:size], weights)) % 11
        if nums[size] != (0 if r < 2 else 11 - r):
            return False
    return True


def resumo_fields(raw: str, slug: str) -> dict | None:
    m = re.search(r'<section class="offer-summary" data-offer-summary="%s"[^>]*>(.*?)</section>' % re.escape(slug), raw, re.S)
    if not m:
        return None
    out = {}
    for f, body in re.findall(r'<div data-field="([a-z_]+)"><dt>[^<]*</dt><dd>(.*?)</dd></div>', m.group(1), re.S):
        out[f] = visible(body)
    return out


def validate(root: Path, findings: list[str]) -> list[str]:
    errs: list[str] = []
    pol = json.loads((root / "data/politica-unica.json").read_text(encoding="utf-8"))
    review = pol.get("legal_review") or {}
    if review.get("status") != "APPROVED" or not review.get("approved_by") or not review.get("approved_at"):
        errs.append("data/politica-unica.json: REVISÃO JURÍDICA PENDENTE; legal_review exige status APPROVED, approved_by e approved_at")
    sup = pol["resumo_oferta"]["fornecedor"]
    catalog = json.loads((root / "data/products.json").read_text(encoding="utf-8"))
    prices = {p["slug"]: p["price"] for p in catalog["products"]}
    sub = catalog.get("subscription") or {}
    # ---- dados do fornecedor
    for k in ("razao_social", "cnpj", "endereco_fisico", "cep", "email", "site"):
        v = sup.get(k)
        if not isinstance(v, str) or not v.strip() or PENDING.search(v):
            errs.append(f"fornecedor.{k} vazio ou pendente em data/politica-unica.json")
    if not cnpj_valid(sup.get("cnpj", "")):
        errs.append(f"fornecedor.cnpj {sup.get('cnpj')!r} com dígitos verificadores inválidos (Decreto 7.962, art. 2º, I)")
    if not re.fullmatch(r"\d{5}-\d{3}", sup.get("cep", "") or ""):
        errs.append("fornecedor.cep fora do formato 00000-000")
    if re.search(r"CEP[^.]*a confirmar", pol["resumo_oferta"].get("nota", ""), re.I):
        findings.append("D7962-2-II: o CEP 63540-000 está anotado em data/politica-unica.json como 'a confirmar pelo proprietário' (CEP único de Várzea Alegre); confirmação do proprietário pendente")
    ident = [sup.get("razao_social", ""), "CNPJ " + sup.get("cnpj", ""), sup.get("endereco_fisico", ""), "CEP " + sup.get("cep", ""), sup.get("email", "")]
    # ---- páginas publicadas do site de vendas
    pages = sorted((root / "sales-public").glob("*.html"))
    if not pages:
        errs.append("sales-public/*.html: nenhuma página publicada encontrada")
    offers = list(pol["policy_surfaces"]["products"]) + list(pol["policy_surfaces"].get("subscription", []))
    priced = 0
    for p in pages:
        raw = p.read_text(encoding="utf-8")
        vis = visible(raw)
        if not PRICE.search(vis) and p.stem not in offers:
            continue
        priced += 1
        where = f"sales-public/{p.name}"
        for need in ident:
            if need not in vis:
                errs.append(f"{where}: página com preço sem '{need}' visível (Decreto 7.962, art. 2º, I e II)")
        if not re.search(r'href="[^"]*/termos[#"]', raw):
            errs.append(f"{where}: página com preço sem link para os termos (Decreto 7.962, art. 4º, I)")
        if not re.search(r'href="[^"]*/(?:reembolso|pedir-reembolso)["#?]', raw):
            errs.append(f"{where}: página com preço sem link para o reembolso (Decreto 7.962, art. 5º)")
    for slug in offers:
        where = f"sales-public/{slug}.html"
        f = root / where
        if not f.is_file():
            errs.append(f"{where}: página de oferta ausente")
            continue
        raw = f.read_text(encoding="utf-8")
        r = resumo_fields(raw, slug)
        if r is None:
            errs.append(f"{where}: sem 'Resumo da oferta' (data-offer-summary) junto à oferta (Decreto 7.962, art. 2º e art. 4º, I)")
            continue
        for k in RESUMO_FIELDS:
            v = r.get(k, "")
            if not v:
                errs.append(f"{where}: Resumo da oferta sem o campo {k} (Decreto 7.962, art. 2º)")
            elif PENDING.search(v):
                errs.append(f"{where}: campo {k} com marcador de pendência")
        if sup.get("razao_social") and sup["razao_social"] not in r.get("fornecedor", ""):
            errs.append(f"{where}: fornecedor do resumo difere da razão social")
        if r.get("cnpj") != sup.get("cnpj"):
            errs.append(f"{where}: CNPJ do resumo ({r.get('cnpj')!r}) difere do fornecedor ({sup.get('cnpj')!r})")
        if "CEP " + sup.get("cep", "") not in r.get("endereco_fisico", "") or sup.get("endereco_fisico", "") not in r.get("endereco_fisico", ""):
            errs.append(f"{where}: endereço físico do resumo incompleto (endereço + CEP)")
        if sup.get("email", "") not in r.get("endereco_eletronico", ""):
            errs.append(f"{where}: endereço eletrônico do resumo sem o e-mail de contato")
        want = prices.get(slug) if slug in prices else (sub.get("price") if slug == sub.get("slug") else None)
        if want is None:
            errs.append(f"{where}: oferta sem preço no catálogo data/products.json")
        elif f"R$ {want},00" not in r.get("preco_total", ""):
            errs.append(f"{where}: preço total do resumo ({r.get('preco_total', '')[:40]!r}) difere do catálogo (R$ {want},00) (CDC art. 31)")
        if "sem taxas adicionais" not in r.get("preco_total", ""):
            errs.append(f"{where}: preço total sem a informação de taxas adicionais (Decreto 7.962, art. 2º, IV)")
        arr = r.get("arrependimento", "")
        if "7 dias corridos" not in arr or "devolução integral" not in arr:
            errs.append(f"{where}: arrependimento sem '7 dias corridos' e 'devolução integral' (CDC art. 49)")
    # ---- termos e reembolso: declarações dos arts. 4º e 5º
    for slug in LEGAL_PAGES:
        f = root / "sales-public" / f"{slug}.html"
        if not f.is_file():
            errs.append(f"sales-public/{slug}.html: página legal ausente")
            continue
        vis = visible(f.read_text(encoding="utf-8"))
        for item, frag in DECLARATIONS.items():
            if frag not in vis:
                errs.append(f"sales-public/{slug}.html: falta a declaração de {item}: {frag!r}")
        if sup.get("email", "") not in vis:
            errs.append(f"sales-public/{slug}.html: sem o e-mail de atendimento (Decreto 7.962, art. 4º, V)")
    # ---- trava fiscal no código (P23 PI; seção 7, F3)
    guard = (root / "worker/commercial-checkout-guard.mjs").read_text(encoding="utf-8")
    m = re.search(r"export const REQUIRED = Object\.freeze\(\[([^\]]*)\]\)", guard)
    req = re.findall(r'"([a-z_]+)"', m.group(1)) if m else []
    if "fiscal" not in req:
        errs.append("worker/commercial-checkout-guard.mjs: REQUIRED sem o sinal 'fiscal' (venda pelo checkout próprio antes do processo fiscal definido)")
    if not re.search(r"fiscal:fiscalProcessDefined\(fiscal,now\)", guard):
        errs.append("worker/commercial-checkout-guard.mjs: sinal 'fiscal' não vem de fiscalProcessDefined")
    ctl = (root / "worker/sales-control.mjs").read_text(encoding="utf-8")
    if "const open = released && fiscalProcessDefined(fiscal);" not in ctl:
        errs.append("worker/sales-control.mjs: /api/sales/status abre sem exigir o processo fiscal definido")
    compat = (root / "worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
    if not re.search(r'"production" &&\s*fiscalProcessDefined\(\);', compat):
        errs.append("worker/cloudflare-worker.compat.mjs: /api/status projeta vendas abertas sem o processo fiscal definido")
    fp = json.loads((root / "data/p23/fiscal-process.json").read_text(encoding="utf-8"))
    st = fp.get("status")
    if fp.get("schema") != "zevanory-p23-fiscal-process/v1" or st not in ("NAO_DEFINIDO", "DEFINIDO"):
        errs.append("data/p23/fiscal-process.json: schema ou status inválido (NAO_DEFINIDO | DEFINIDO)")
    if st == "NAO_DEFINIDO":
        if fp.get("decision") is not None:
            errs.append("data/p23/fiscal-process.json: NAO_DEFINIDO não pode trazer decision (nada é preenchido antes da decisão do proprietário)")
        findings.append("P23-F3-FISCAL: processo fiscal NAO_DEFINIDO (classe D, proprietário com o contador, 26/10/2026): checkout próprio e status público ficam fechados por este sinal")
    elif st == "DEFINIDO":
        d = fp.get("decision") or {}
        for k in FISCAL_FIELDS:
            v = d.get(k)
            if k == "procedure_ref":
                ok = isinstance(v, dict) and v.get("kind") == "repo" and isinstance(v.get("ref"), str) and (root / v["ref"]).is_file() \
                    and isinstance(v.get("contains"), str) and len(v["contains"]) >= 8 and v["contains"] in (root / v["ref"]).read_text(encoding="utf-8")
                if not ok:
                    errs.append("data/p23/fiscal-process.json: procedure_ref deve apontar para o procedimento escrito no repositório (trecho verificável)")
            elif not isinstance(v, str) or len(v.strip()) < 2 or PENDING.search(v):
                errs.append(f"data/p23/fiscal-process.json: DEFINIDO sem decision.{k}")
        if d.get("decided_by") != "proprietario":
            errs.append("data/p23/fiscal-process.json: decided_by deve ser 'proprietario' (classe D)")
    # ---- checklist: itens citados e cobertos
    ck = json.loads((root / "data/p23/ecommerce-legal-checklist.json").read_text(encoding="utf-8"))
    ids = [i.get("id") for i in ck.get("items", [])]
    for need in list(DECLARATIONS) + ["D7962-2-I", "D7962-2-II", "D7962-2-III", "D7962-2-IV", "D7962-2-V", "D7962-2-VI", "D7962-5", "CDC-31", "P23-F3-FISCAL"]:
        if need not in ids:
            errs.append(f"checklist: item {need} ausente de data/p23/ecommerce-legal-checklist.json")
    for i in ck.get("items", []):
        if not i.get("basis") or not i.get("requirement") or i.get("verification") not in ("static", "static_parcial", "checkout_flow", "processo", "codigo"):
            errs.append(f"checklist: item {i.get('id')} sem norma, requisito ou forma de verificação")
        if i.get("verification") in ("checkout_flow", "static_parcial", "processo"):
            findings.append(f"{i['id']}: {i['requirement']} -> NÃO VERIFICÁVEL ESTATICAMENTE ({i.get('note') or 'prova na fase F3'})")
    # ---- páginas-fonte fora do site de vendas (relatadas, não reprovadas)
    src_missing = []
    for p in sorted(root.glob("*/index.html")):
        if p.parent.name in ("sales-public", "tests", "docs", "evidence"):
            continue
        vis = visible(p.read_text(encoding="utf-8"))
        if PRICE.search(vis) and not all(n in vis for n in ident):
            src_missing.append(p.parent.name)
    if src_missing:
        findings.append(f"D7962-2-I/II: {len(src_missing)} páginas-fonte na raiz do repositório (*/index.html, canônicas em zevanory.api.br/<página>) mostram preço sem a identificação completa do fornecedor: "
                        f"{', '.join(src_missing[:8])}{' ...' if len(src_missing) > 8 else ''}. O site de vendas publicado (sales-public) está completo; se essas páginas-fonte forem servidas ao público (espelho GitHub Pages ou rota da apex), precisam do mesmo rodapé")
    print(f"P23_PAGES priced={priced} offers={len(offers)} legal={len(LEGAL_PAGES)} fiscal_status={st} checklist_items={len(ids)}")
    return errs


def main(argv: list[str] | None = None) -> int:
    # python3 -I ignora PYTHONIOENCODING; no Windows a saída cairia em cp1252 e os acentos se perderiam.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--cnpj", help="só confere os dígitos de um CNPJ (testes)")
    args = ap.parse_args(argv)
    if args.cnpj is not None:
        print("CNPJ_VALID" if cnpj_valid(args.cnpj) else "CNPJ_INVALID")
        return 0
    findings: list[str] = []
    try:
        errs = validate(Path(args.root), findings)
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        print(f"::error title=P23::entrada ilegível: {exc!r}")
        print("P23_GATE=FAIL errors=1")
        return 1
    for f in findings:
        print(f"FINDING {f}")
    for e in errs:
        print(f"::error title=P23::{e}")
    print(f"P23_GATE={'FAIL' if errs else 'PASS'} errors={len(errs)} findings={len(findings)}")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
