#!/usr/bin/env python3
"""Compara o preço canônico (data/products.json) com o preço da oferta na Hotmart. SOMENTE LEITURA, execução manual.

Nunca roda no CI, nunca grava nada na Hotmart e nunca imprime credencial. Dois modos:

  1) Leitura pela API (GET), com credenciais do proprietário em variáveis de ambiente:
       HOTMART_CLIENT_ID, HOTMART_CLIENT_SECRET, HOTMART_BASIC (o "Basic" do painel de credenciais da Hotmart)
     python3 scripts/hotmart_price_compare.py --map ZEV-IA-011=<product_id>:<offer_code> [--map ...]
     ATENÇÃO: os endereços abaixo (token e ofertas) NÃO foram conferidos na documentação oficial nesta sessão
     (developers.hotmart.com não estava acessível daqui). Antes de usar, o proprietário confere em
     https://developers.hotmart.com/docs e ajusta com --token-url / --offers-url se preciso.
  2) Leitura manual: o proprietário copia o preço que a Hotmart mostra e informa em um JSON
       {"ZEV-IA-011": <preço>, "conteudo-pronto": <preço>, ...}
     python3 scripts/hotmart_price_compare.py --from-json precos_lidos_na_hotmart.json

Saída: uma linha por produto (sku, canônico, Hotmart, IGUAL/DIVERGE/NAO_LIDO); exit 1 se algum diverge.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN_URL = "https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials"
OFFERS_URL = "https://developers.hotmart.com/products/api/v1/products/{product_id}/offers"


def canonical() -> dict[str, float]:
    d = json.loads((ROOT / "data/products.json").read_text(encoding="utf-8"))
    out = {p["sku"]: float(p["price"]) for p in d["products"]}
    out["conteudo-pronto"] = float(d["subscription"]["price"])
    return out


def _get_json(url: str, headers: dict, method: str = "GET") -> dict:
    if method not in ("GET", "POST_TOKEN"):
        raise SystemExit("somente leitura")
    req = urllib.request.Request(url, headers=headers, method="POST" if method == "POST_TOKEN" else "GET")
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 (URL fixa ou informada pelo proprietário)
        return json.loads(r.read().decode("utf-8"))


def _hotmart_https(url: str) -> str:
    """Credenciais só vão para https em *.hotmart.com (auditoria #954 LOW: --token-url não pode desviar o segredo)."""
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    if u.scheme != "https" or not (host == "hotmart.com" or host.endswith(".hotmart.com")) or u.username or u.password:
        raise SystemExit("URL recusada: só https em *.hotmart.com")
    return url


def read_api(mapping: dict[str, str], token_url: str, offers_url: str) -> dict[str, float | None]:
    _hotmart_https(token_url)
    _hotmart_https(offers_url.format(product_id="0"))
    cid, secret, basic = (os.environ.get(k, "") for k in ("HOTMART_CLIENT_ID", "HOTMART_CLIENT_SECRET", "HOTMART_BASIC"))
    if not (cid and secret and basic):
        raise SystemExit("defina HOTMART_CLIENT_ID, HOTMART_CLIENT_SECRET e HOTMART_BASIC (nada é impresso)")
    # O formato de token da Hotmart leva client_id/client_secret na query; a URL nunca é impressa nem registrada.
    url = token_url + "&" + urllib.parse.urlencode({"client_id": cid, "client_secret": secret})
    token = _get_json(url, {"Authorization": "Basic " + basic}, "POST_TOKEN").get("access_token")  # emissão de token, não altera dados
    if not token:
        raise SystemExit("token não emitido")
    out: dict[str, float | None] = {}
    for sku, ref in mapping.items():
        product_id, _, offer_code = ref.partition(":")
        data = _get_json(offers_url.format(product_id=urllib.parse.quote(product_id)), {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        items = data.get("items") or data.get("offers") or []
        hit = next((o for o in items if not offer_code or str(o.get("code") or o.get("offer_code")) == offer_code), None)
        price = (hit or {}).get("price") or {}
        value = price.get("value") if isinstance(price, dict) else price
        out[sku] = float(value) if value is not None else None
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--map", action="append", default=[], help="SKU=<product_id>:<offer_code>")
    ap.add_argument("--from-json", help="JSON com os preços lidos manualmente na Hotmart")
    ap.add_argument("--token-url", default=TOKEN_URL)
    ap.add_argument("--offers-url", default=OFFERS_URL)
    a = ap.parse_args(argv)
    canon = canonical()
    if a.from_json:
        hot = {k: (float(v) if v is not None else None) for k, v in json.loads(Path(a.from_json).read_text(encoding="utf-8")).items()}
    elif a.map:
        hot = read_api(dict(m.split("=", 1) for m in a.map), a.token_url, a.offers_url)
    else:
        ap.error("informe --from-json ou --map")
    bad = 0
    for sku, price in canon.items():
        h = hot.get(sku)
        state = "NAO_LIDO" if h is None else ("IGUAL" if abs(h - price) < 0.005 else "DIVERGE")
        bad += state == "DIVERGE"
        print(f"{sku}\tcanonico={price:.2f}\thotmart={'-' if h is None else f'{h:.2f}'}\t{state}")
    print(f"HOTMART_PRECO={'DIVERGE' if bad else 'OK_OU_NAO_LIDO'} divergentes={bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
