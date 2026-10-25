#!/usr/bin/env python3
"""ZEVANORY | Leitura pós-publicação do Release consolidado (Sol, Ordens 265-268).

Rodar SOMENTE depois do merge autorizado em gh-pages e dos deploys que ele dispara
(central-production-deploy -> Worker "zevanory"; zevanory-sales-public-release -> Worker "zevanory-sales-public").
Só faz GET/HEAD públicos: sem credenciais, sem POST, sem efeito colateral.

Os valores esperados saem da ÁRVORE DESTE CHECKOUT (o SHA publicado), não de constantes:
  title / h1 / canonical / robots de sales-public/<rota>.html e sales-public/404.html.
Mais as asserções explícitas do Release: vendas fechadas, trava fiscal (P23), página 404, textos de promessa (#927/#898),
cabeçalhos de segurança, redirecionamento 308 da apex para o domínio de vendas, identidade de release dos dois Workers
e a cópia GitHub Pages como camada noindex de redirecionamento (#935, esperado = pages-mirror/<rota>.html).

Uso:
  git checkout <SHA mesclado em gh-pages>
  python3 scripts/release/post_publication_readback.py --expected-sha <SHA> [--out readback.json]
  (--skip-central-identity se o central-production-deploy não tiver rodado/concluído para esse SHA)
Sai 0 só se TODAS as verificações passarem; imprime READBACK=PASS|FAIL e grava a evidência JSON.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import sales_promise_consistency as promise  # noqa: E402  (mesmas regex do gate de PR)

APEX = "https://zevanory.api.br"
SALES = "https://vendas.zevanory.api.br"
PAGES = "https://arbmsistone-lab.github.io/zevanory-public-mirror"
PRODUCTS = ("ia-na-pratica", "vendas-na-pratica", "combo-ia-vendas", "lucro-e-caixa", "negocio-completo")
ROUTES = PRODUCTS + ("conteudo-pronto", "solucoes", "kit-afiliado", "quem-criou", "termos", "privacidade", "reembolso",
                     "afiliados", "material-gratuito")
UA = "ZEVANORY-RELEASE-READBACK/1.0"
CHECKOUT_HREF = re.compile(r'href=["\'][^"\']*(checkout|/comprar|mercadopago|stripe|pagamento\?)', re.I)

# Textos de promessa que o Release tem de servir (fonte: #927 e #898), por rota.
MUST_CONTAIN = {
    "combo-ia-vendas": ["IA com método e vendas organizadas, em um só pacote."],
    "conteudo-pronto": ["roteiros multicanal"],
    "kit-afiliado": ["roteiros multicanal", "treinamentos completos, que podem ser usados de forma independente"],
    "solucoes": ["roteiros multicanal", "e vendas, cada um no seu ritmo"],
}
MUST_NOT_CONTAIN = {
    "combo-ia-vendas": ["Conecte IA ao processo comercial", "Execução comercial com IA"],
    "conteudo-pronto": ["mensagens de venda para WhatsApp"],
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def fetch(url, follow=True, method="GET"):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "text/html,application/json",
                                                              "Cache-Control": "no-cache"})
    try:
        with opener.open(req, timeout=25) as r:
            return r.status, r.read().decode("utf-8", "replace"), {k.lower(): v for k, v in r.headers.items()}, r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), {k.lower(): v for k, v in e.headers.items()}, url


def fields(html):
    def one(rx):
        m = re.search(rx, html, re.I | re.S)
        return re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else None
    canon = re.search(r'<link\b[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']+)', html, re.I)
    robots = re.search(r'<meta\b[^>]*name=["\']robots["\'][^>]*content=["\']([^"\']+)', html, re.I)
    return {"title": one(r"<title>(.*?)</title>"), "h1": one(r"<h1[^>]*>(.*?)</h1>"),
            "canonical": canon.group(1) if canon else None, "robots": robots.group(1).lower() if robots else None}


class Run:
    def __init__(self):
        self.checks = []

    def check(self, name, ok, **detail):
        self.checks.append({"check": name, "ok": bool(ok), **detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" {json.dumps(detail, ensure_ascii=False)[:600]}"))
        return ok


def security_headers(run, name, h):
    run.check(f"{name}:hsts", bool(h.get("strict-transport-security")))
    run.check(f"{name}:csp", bool(h.get("content-security-policy")))
    run.check(f"{name}:nosniff", "nosniff" in h.get("x-content-type-options", "").lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected-sha", required=True)
    ap.add_argument("--out", default="release-readback.json")
    ap.add_argument("--skip-central-identity", action="store_true")
    a = ap.parse_args()
    sha = a.expected_sha.lower()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        sys.exit("--expected-sha must be a full 40-hex SHA")
    run = Run()

    # 1) Identidade dos releases.
    c, body, _, _ = fetch(f"{SALES}/health")
    try:
        sh = json.loads(body)
    except ValueError:
        sh = {}
    run.check("sales-worker:health", c == 200 and sh.get("ok") is True, status=c)
    run.check("sales-worker:release==expected", sh.get("release") == sha, got=sh.get("release"), expected=sha)
    run.check("sales-worker:commercial_surface", sh.get("commercial_surface") == "fail-closed", got=sh.get("commercial_surface"))
    c, body, _, _ = fetch(f"{APEX}/api/release")
    rel = json.loads(body) if c == 200 else {}
    runtime = str(rel.get("deployment", {}).get("commit_sha", "")).lower()
    if a.skip_central_identity:
        run.check("central-worker:release(reported only)", c == 200, got=runtime)
    else:
        run.check("central-worker:release==expected", runtime == sha, got=runtime, expected=sha)
    c, body, _, _ = fetch(f"{APEX}/api/health")
    hj = json.loads(body) if c == 200 else {}
    run.check("central-worker:health live+ready", hj.get("live") is True and hj.get("ready") is True, got=hj)

    # 2) Vendas fechadas + trava fiscal (P23).
    c, body, h, _ = fetch(f"{APEX}/api/sales/status")
    st = json.loads(body) if c == 200 else {}
    run.check("sales:status open=false", c == 200 and st.get("open") is False, got=st)
    run.check("sales:release sales_mode=globally-blocked", rel.get("sales_mode") == "globally-blocked", got=rel.get("sales_mode"))
    fiscal = json.loads((ROOT / "data/p23/fiscal-process.json").read_text("utf-8"))
    fiscal_defined = fiscal.get("status") == "DEFINIDO"
    run.check("fiscal-lock:source status != DEFINIDO", not fiscal_defined, status=fiscal.get("status"))
    # Com a trava, mesmo um interruptor liberado não abre: blocked passa a ser fiscal_process_undefined.
    if st.get("requested") is True or st.get("blocked") in ("fiscal_process_undefined", "release_or_financial_proof_pending"):
        run.check("fiscal-lock:blocked reason", st.get("open") is False and st.get("blocked") in
                  ("fiscal_process_undefined", "release_or_financial_proof_pending"), got=st.get("blocked"))
    else:
        run.check("fiscal-lock:switch closed upstream (open=false, reason recorded)", st.get("open") is False, blocked=st.get("blocked"))

    # 3) Páginas de venda: title/h1/canonical/robots == fonte do SHA, cabeçalhos, sem checkout, promessas.
    for route in ROUTES:
        src = ROOT / "sales-public" / f"{route}.html"
        if not src.is_file():
            run.check(f"{route}:source present", False, path=str(src))
            continue
        exp = fields(src.read_text("utf-8"))
        c, html, h, final = fetch(f"{SALES}/{route}")
        got = fields(html)
        run.check(f"{route}:status 200", c == 200, status=c)
        for k in ("title", "h1", "canonical", "robots"):
            run.check(f"{route}:{k}", got[k] == exp[k], live=got[k], expected=exp[k])
        security_headers(run, route, h)
        run.check(f"{route}:no checkout link (sales closed)", not CHECKOUT_HREF.search(html))
        for t in MUST_CONTAIN.get(route, []):
            run.check(f"{route}:contains {t[:50]!r}", t in html)
        for t in MUST_NOT_CONTAIN.get(route, []):
            run.check(f"{route}:absent {t[:50]!r}", t not in html)
        if route in promise.PRODUCTS:
            n = promise.norm(html)
            run.check(f"{route}:promise no prospecção", not promise.PROSPECT.search(n))
            if route == "combo-ia-vendas":
                run.check(f"{route}:promise no integrated-IA claim", not promise.INTEGRATED.search(n))

    # 4) Apex -> domínio de vendas (308) para os 5 produtos.
    for slug in PRODUCTS:
        c, _, h, _ = fetch(f"{APEX}/{slug}", follow=False)
        run.check(f"apex/{slug}:308 -> vendas", c == 308 and h.get("location", "").rstrip("/") == f"{SALES}/{slug}",
                  status=c, location=h.get("location"))

    # 5) 404 projetado.
    nf_exp = fields((ROOT / "sales-public/404.html").read_text("utf-8"))
    probe = f"{SALES}/readback-inexistente-{uuid.uuid4().hex[:10]}"
    c, html, h, _ = fetch(probe)
    got = fields(html)
    run.check("404:status", c == 404, status=c, url=probe)
    for k in ("title", "h1", "robots"):
        run.check(f"404:{k}", got[k] == nf_exp[k], live=got[k], expected=nf_exp[k])
    run.check("404:noindex", "noindex" in (got["robots"] or ""))

    # 6) Cópia GitHub Pages = camada de redirecionamento noindex (#935): esperado = pages-mirror/<rota>.html do SHA.
    for route in ("solucoes", "combo-ia-vendas", "conteudo-pronto", "kit-afiliado"):
        stub = ROOT / "pages-mirror" / f"{route}.html"
        if not stub.is_file():
            run.check(f"pages/{route}:stub source present", False, path=str(stub))
            continue
        exp = fields(stub.read_text("utf-8"))
        c, html, _, _ = fetch(f"{PAGES}/{route}/")
        got = fields(html)
        run.check(f"pages/{route}:status 200", c == 200, status=c)
        for k in ("title", "canonical", "robots"):
            run.check(f"pages/{route}:{k}", got[k] == exp[k], live=got[k], expected=exp[k])
        run.check(f"pages/{route}:noindex+refresh->vendas", "noindex" in (got["robots"] or "") and
                  f'url={SALES}/{route}"' in html)

    ok = all(x["ok"] for x in run.checks)
    out = {"schema": "zevanory.release.readback.v1", "expected_sha": sha, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "checks": run.checks, "total": len(run.checks), "failed": sum(1 for x in run.checks if not x["ok"]),
           "verdict": "PASS" if ok else "FAIL"}
    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"READBACK={'PASS' if ok else 'FAIL'} total={out['total']} failed={out['failed']} out={a.out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
