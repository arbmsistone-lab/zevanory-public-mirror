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

for _part in (RULE_7D, DELIVERY_72H):
    assert _part in SOL_TEXT, _part

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


CHECKOUT_HREF_RE = re.compile(r"""href\s*=\s*["']?[^"'\s>]*/comprar/""", re.I)
INSTOCK_RE = re.compile(r"schema\.org/InStock", re.I)


def audit_closed(out_dir: Path) -> list[str]:
    """Grep-gate do modo fechado: zero href para /comprar/ e zero InStock em qualquer HTML."""
    problems = []
    for f in sorted(out_dir.glob("*.html")):
        text = f.read_text(encoding="utf-8")
        if CHECKOUT_HREF_RE.search(text):
            problems.append(f"{f.name}: href /comprar/ em modo fechado")
        if INSTOCK_RE.search(text):
            problems.append(f"{f.name}: schema.org/InStock em modo fechado")
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
    problems = audit_policy(out)
    if a.mode == CLOSED:
        problems += audit_closed(out)
    for p in problems:
        print("P13_FAIL " + p)
    print("P13_AUDIT=" + ("FAIL" if problems else "PASS") + " mode=" + a.mode)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
