#!/usr/bin/env python3
"""Preço canônico: data/products.json é a ÚNICA definição de preço de cada produto e da assinatura.

    python3 scripts/sync_canonical_prices.py          # grava o preço canônico em todas as superfícies
    python3 scripts/sync_canonical_prices.py --check  # CI: falha (exit 1) se alguma superfície divergir

Superfícies (cada uma é reescrita a partir de data/products.json; nenhuma tem preço próprio):
  - checkout próprio: worker/cloudflare-worker.recovered.mjs (ZEVANORY_PRODUCTS: table_price_brl e pilot_price_brl,
    que resolveCheckoutOffer usa como unit_price da preferência);
  - página e JSON-LD: scripts/build_sales_public.py lê data/products.json diretamente (sem literal); o resumo da oferta
    e as contas de economia dos pacotes são calculados; conteudo-pronto/index.html e data/politica-unica.json
    (preço da assinatura);
  - /comprar e JSON-LD na abertura: worker/sales-public-worker.mjs (PRICES e oferta do Service);
  - atendimento e chat: worker/support-knowledge.mjs;
  - materiais de divulgação: worker/acquisition-engine.mjs, worker/creative-autonomy.mjs, worker/lead-magnet.mjs,
    worker/multichannel-autonomy.mjs;
  - prova sandbox: worker/sandbox-proof-v2.mjs e scripts/mercadopago_combo_sandbox.py;
  - mapa P24: data/p24/promise-map.json (texto das promessas de economia).
Depois de mudar um preço: rode este script e scripts/build_sales_public.py; o CI confere os dois.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load():
    d = json.loads((ROOT / "data/products.json").read_text(encoding="utf-8"))
    by_slug = {p["slug"]: p for p in d["products"]}
    return d, by_slug, {p["sku"]: p["price"] for p in d["products"]}, int(d["subscription"]["price"])


def economy(by_slug, slug, parts):
    total = sum(by_slug[s]["price"] for s in parts)
    return total - by_slug[slug]["price"], total


def rules(d, by_slug, by_sku, sub):
    cmb_eco, cmb_sep = economy(by_slug, "combo-ia-vendas", ["ia-na-pratica", "vendas-na-pratica"])
    ngc_eco, ngc_sep = economy(by_slug, "negocio-completo", ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa"])
    R = []  # (arquivo, regex, função de substituição, ocorrências esperadas)
    sku_re = "|".join(map(re.escape, by_sku))
    slug_re = "|".join(map(re.escape, by_slug))
    rec = "worker/cloudflare-worker.recovered.mjs"
    R.append((rec, rf'(sku: "({sku_re})",[^\n]*?table_price_brl: )\d+(, pilot_price_brl: )\d+', lambda m: f"{m.group(1)}{by_sku[m.group(2)]}{m.group(3)}{by_sku[m.group(2)]}", len(by_sku)))
    R.append(("worker/sales-public-worker.mjs", rf'("({sku_re})":\["[^"]+",)\d+(\])', lambda m: f"{m.group(1)}{by_sku[m.group(2)]}{m.group(3)}", len(by_sku)))
    R.append(("worker/sales-public-worker.mjs", r'(n\.offers=\{"@type":"Offer",price:")\d+(\.00",priceCurrency:"BRL",url:SALES_ORIGIN\+"/conteudo-pronto")', lambda m: f"{m.group(1)}{sub}{m.group(2)}", 1))
    R.append(("worker/acquisition-engine.mjs", rf'(sku:"({sku_re})",name:"[^"]+",price:)\d+', lambda m: f"{m.group(1)}{by_sku[m.group(2)]}", len(by_sku)))
    R.append(("worker/support-knowledge.mjs", rf'("({slug_re})": \{{ name: "[^"]+", price_brl: )\d+', lambda m: f"{m.group(1)}{by_slug[m.group(2)]['price']}", len(by_slug)))
    R.append(("worker/support-knowledge.mjs", r'(name: "Conteúdo Pronto \(assinatura mensal\)", price_brl: )\d+', lambda m: f"{m.group(1)}{sub}", 1))
    R.append(("worker/creative-autonomy.mjs", rf'(slug:"({slug_re})",name:"[^"]+",price_brl:)\d+', lambda m: f"{m.group(1)}{by_slug[m.group(2)]['price']}", len(by_slug)))
    R.append(("worker/lead-magnet.mjs", rf'(name: "[^"]+", price: )\d+(, slug: "({slug_re})")', lambda m: f"{m.group(1)}{by_slug[m.group(3)]['price']}{m.group(2)}", 3))
    R.append(("worker/lead-magnet.mjs", r'por R\$ \d+ \(separados custariam R\$ \d+\)', lambda m: f"por R$ {by_slug['negocio-completo']['price']} (separados custariam R$ {ngc_sep})", 1))
    R.append(("worker/multichannel-autonomy.mjs", rf'"({sku_re})":\d+', lambda m: f'"{m.group(1)}":{by_sku[m.group(1)]}', len(by_sku)))
    ia = by_slug["ia-na-pratica"]["price"]  # texto genérico do blog ("a solução por R$ X") = preço do IA na Prática
    R.append(("worker/multichannel-autonomy.mjs", r'Conheça a solução por R\$ \d+,00', lambda m: f"Conheça a solução por R$ {ia},00", 1))
    R.append(("worker/multichannel-autonomy.mjs", r'price_brl:\d+\},\{serverPrice:\d+,', lambda m: f"price_brl:{ia}}},{{serverPrice:{ia},", 1))
    R.append(("worker/multichannel-autonomy.mjs", r'\[article\.product\]\|\|\d+', lambda m: f"[article.product]||{ia}", 1))
    R.append(("worker/sandbox-proof-v2.mjs", rf'(\n  "({sku_re})": )\d+', lambda m: f"{m.group(1)}{by_sku[m.group(2)]}", len(by_sku)))
    R.append(("worker/sandbox-proof-v2.mjs", r'(export const SANDBOX_AMOUNT_BRL = )\d+', lambda m: f"{m.group(1)}{by_sku['ZEV-CMB-011']}", 1))
    R.append(("scripts/mercadopago_combo_sandbox.py", rf"('({sku_re})': )\d+(?=[,}}])", lambda m: f"{m.group(1)}{by_sku[m.group(2)]}", len(by_sku)))
    R.append(("conteudo-pronto/index.html", r'R\$ \d+(/mês| por mês)', lambda m: f"R$ {sub}{m.group(1)}", 2))
    R.append(("data/politica-unica.json", r'("preco_total": "R\$ )\d+(,00 por mês)', lambda m: f"{m.group(1)}{sub}{m.group(2)}", 1))
    R.append(("sales-overlay/approved.json", rf'("({slug_re})": "(?:[^"\\]|\\.)*?Preço de tabela: R\$ )\d+', lambda m: f"{m.group(1)}{by_slug[m.group(2)]['price']}", 5))
    R.append(("sales-overlay/llms.txt", rf'(\]\(https://vendas\.zevanory\.api\.br/({slug_re})\)[^\n]*?R\$ )\d+', lambda m: f"{m.group(1)}{by_slug[m.group(2)]['price']}", len(by_slug)))
    R.append(("sales-overlay/llms.txt", r'(\]\(https://vendas\.zevanory\.api\.br/conteudo-pronto\)[^\n]*?R\$ )\d+(/mês)', lambda m: f"{m.group(1)}{sub}{m.group(2)}", 1))
    pm = "data/p24/promise-map.json"
    R.append((pm, r'"Economia de R\$ \d+ em relação à compra separada \(R\$ \d+\)"(?=,\s*"type": "price",\s*"components": \[\s*"ia-na-pratica",\s*"vendas-na-pratica"\s*\])',
              lambda m: f'"Economia de R$ {cmb_eco} em relação à compra separada (R$ {cmb_sep})"', 1))
    R.append((pm, r'"Economia de R\$ \d+ em relação à compra separada \(R\$ \d+\)"(?=,\s*"type": "price",\s*"components": \[\s*"ia-na-pratica",\s*"vendas-na-pratica",\s*"lucro-e-caixa"\s*\])',
              lambda m: f'"Economia de R$ {ngc_eco} em relação à compra separada (R$ {ngc_sep})"', 1))
    return R


def main(argv=None) -> int:
    check = "--check" in (argv if argv is not None else sys.argv[1:])
    d, by_slug, by_sku, sub = load()
    problems, changed = [], []
    texts = {}
    for f, rx, fn, want in rules(d, by_slug, by_sku, sub):
        t = texts.setdefault(f, (ROOT / f).read_text(encoding="utf-8"))
        new, n = re.subn(rx, fn, t)
        if n != want:
            problems.append(f"{f}: padrão {rx[:60]}… casou {n} vez(es), esperado {want} (a superfície mudou de forma: ajuste o sincronizador)")
        texts[f] = new
    for f, t in texts.items():
        if t != (ROOT / f).read_text(encoding="utf-8"):
            changed.append(f)
            if not check:
                (ROOT / f).write_text(t, encoding="utf-8")
    for p in problems:
        print("::error title=preco-canonico::" + p)
    if check and changed:
        for f in changed:
            print(f"::error title=preco-canonico::{f} diverge de data/products.json (rode python3 scripts/sync_canonical_prices.py)")
    print(f"PRECO_CANONICO={'FAIL' if problems or (check and changed) else 'OK'} superficies={len(texts)} alteradas={len(changed)}")
    return 1 if problems or (check and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
