#!/usr/bin/env python3
"""ZEVANORY | P01 Fase A: gera as 3 páginas de lista de espera (mesmo modelo) a partir de
data/fase-a-nichos.json + scripts/fase_a/template.html.tpl, e audita o resultado.

Bandeira (padrão DESLIGADO): sem ZEVANORY_FASE_A_PAGES=on nada é escrito, exceto em --preview,
que só aceita destino FORA de sales-public/ (pasta publicada pelo Worker de vendas). Com a bandeira
ligada (decisão de lançamento do proprietário, PR próprio), o destino precisa ter a Política de
Privacidade com a seção da lista de espera (id="lista-de-espera"); sem ela o build falha.

Uso:  python3 scripts/fase_a/build_fase_a.py --out DIR [--preview]
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "fase-a-nichos.json"
# ZEVANORY_FASE_A_TPL: só para o executor de mutantes (scripts/fase_a/mutants.mjs), sempre com --preview.
TPL = Path(os.environ.get("ZEVANORY_FASE_A_TPL") or ROOT / "scripts" / "fase_a" / "template.html.tpl")
CSS = ROOT / "scripts" / "fase_a" / "fase-a.css"
SALES_PUBLIC = (ROOT / "sales-public").resolve()


def consent_version() -> str:
    m = re.search(r'export const CONSENT_VERSION = "([^"]+)"', (ROOT / "worker" / "waitlist.mjs").read_text(encoding="utf-8"))
    if not m:
        raise SystemExit("FASE_A: CONSENT_VERSION ausente em worker/waitlist.mjs")
    return m.group(1)


def render(niche: dict, data: dict, version: str) -> str:
    e = lambda s: html.escape(s, quote=True)
    items = "".join(f"<li>{e(i)}</li>" for i in niche["items"])
    values = {"slug": niche["slug"], "eyebrow": niche["eyebrow"], "product": niche["product"], "h1": niche["h1"], "intro": niche["intro"],
              "q_recurring": niche["q_recurring"], "q_digital": data["q_digital"], "price_label": data["price_label"], "consent_version": version}
    out = TPL.read_text(encoding="utf-8")
    out = out.replace("{{items}}", items)
    for k, v in values.items():
        out = out.replace("{{" + k + "}}", e(v))
    if "{{" in out:
        raise SystemExit("FASE_A: marcador sem valor: " + re.search(r"\{\{[^}]*\}\}", out).group(0))
    return out


def skeleton(page: str, slug: str = "") -> str:
    """Estrutura sem os textos do nicho: sequência de tags com nomes de atributos, valores vazios
    exceto os que definem comportamento (type, name, required/checked como atributos booleanos)."""
    keep = re.compile(r'^(type|name|method|action|href|src|rel|class|id|for|autocomplete|maxlength|tabindex|aria-[a-z]+)$')
    def norm(tag: str) -> str:
        return re.sub(r'([a-zA-Z-]+)="([^"]*)"', lambda m: m.group(1) + '="' + (m.group(2) if keep.match(m.group(1)) and not (m.group(1) == "value") else "") + '"', tag)
    if slug:
        page = page.replace("/" + slug + ".css", "/{nicho}.css")
    return "".join(norm(t) for t in re.findall(r"<[^>]+>", page))


def audit(pages: dict[str, str], data: dict, version: str) -> list[str]:
    problems: list[str] = []
    skel = {slug: skeleton(p, slug) for slug, p in pages.items()}
    if len(set(skel.values())) != 1:
        problems.append("os 3 nichos não usam o mesmo modelo (estrutura diferente)")
    for slug, p in pages.items():
        low = p.lower()
        if re.search(r"""href\s*=\s*["']?[^"' >]*/comprar/""", p, re.I) or "/comprar/" in low:
            problems.append(f"{slug}: link /comprar/")
        if "schema.org/instock" in low or '"offers"' in low or "application/ld+json" in low:
            problems.append(f"{slug}: dado estruturado de oferta/estoque")
        if 'name="robots" content="noindex,nofollow"' not in p:
            problems.append(f"{slug}: falta noindex")
        boxes = re.findall(r'<input[^>]*type="checkbox"[^>]*>', p)
        consent = [b for b in boxes if 'name="consentimento"' in b]
        interview = [b for b in boxes if 'name="entrevista"' in b]
        if len(boxes) != 2 or len(consent) != 1 or "required" not in consent[0]:
            problems.append(f"{slug}: consentimento da lista ausente ou opcional")
        if len(interview) != 1 or "required" in interview[0]:
            problems.append(f"{slug}: convite para entrevista ausente ou obrigatório")
        if any(re.search(r"\bchecked\b", b) for b in boxes):
            problems.append(f"{slug}: caixa pré-marcada")
        if re.search(r"<input[^>]*\bchecked\b", p):
            problems.append(f"{slug}: campo pré-marcado")
        if 'href="/privacidade"' not in p or 'href="/lista-de-espera/sair"' not in p:
            problems.append(f"{slug}: falta link da Política de Privacidade ou de saída")
        if f'data-consent-version="{version}"' not in p:
            problems.append(f"{slug}: versão do consentimento diferente da do backend")
        for must in ("CNPJ 69.077.233/0001-99", "12 meses", "30 dias após a decisão", "legítimo interesse", "não são guardados em claro", "180 dias", "8 dias", data["price_label"]):
            if must not in p:
                problems.append(f"{slug}: falta '{must}'")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--no-audit", action="store_true", help="só com --preview: os testes fazem as próprias asserções")
    a = ap.parse_args()
    if (a.no_audit or os.environ.get("ZEVANORY_FASE_A_TPL")) and not a.preview:
        raise SystemExit("FASE_A: --no-audit e ZEVANORY_FASE_A_TPL exigem --preview")
    out = Path(a.out).resolve()
    flag = os.environ.get("ZEVANORY_FASE_A_PAGES", "").strip().lower() == "on"
    inside_sales = out == SALES_PUBLIC or SALES_PUBLIC in out.parents
    if not flag and not a.preview:
        print("FASE_A_PAGES=OFF (ZEVANORY_FASE_A_PAGES != on): nada foi gerado")
        return 0
    if a.preview and inside_sales:
        raise SystemExit("FASE_A: --preview não pode escrever em sales-public/ (assets publicados)")
    if flag and not a.preview:
        policy = out / "privacidade.html"
        if not policy.exists() or 'id="lista-de-espera"' not in policy.read_text(encoding="utf-8"):
            raise SystemExit("FASE_A: Política de Privacidade sem a seção id=\"lista-de-espera\"; lançamento bloqueado")
    data = json.loads(DATA.read_text(encoding="utf-8"))
    version = consent_version()
    pages = {n["slug"]: render(n, data, version) for n in data["nichos"]}
    problems = [] if a.no_audit else audit(pages, data, version)
    if problems:
        raise SystemExit("FASE_A audit falhou: " + "; ".join(problems))
    out.mkdir(parents=True, exist_ok=True)
    for n in data["nichos"]:
        (out / f"{n['page']}.html").write_text(pages[n["slug"]], encoding="utf-8")
    shutil.copy2(CSS, out / "fase-a.css")
    print("FASE_A_PAGES=" + ("ON" if flag and not a.preview else "PREVIEW") + " paginas=" + ",".join(f"{n['page']}.html" for n in data["nichos"]))
    print("FASE_A_STATIC_AUDIT=" + ("SKIPPED(--no-audit)" if a.no_audit else "PASS"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
