#!/usr/bin/env python3
"""Mutantes /comprar/ noindex (auditor Sol, AVAL 100): cada mutante altera UMA CÓPIA temporária do Worker de
vendas, do sitemap, do robots.txt ou de uma página publicada, roda tests/comprar-noindex.test.mjs contra a cópia
e só conta como morto se o teste falhar COM A ASSERÇÃO ESPERADA (texto do rótulo da asserção na saída). O
repositório original nunca é modificado.
Imprime `MUTANT <id> KILLED|SURVIVED` e sai != 0 se algum sobreviver ou se a suíte sem mutação falhar.
Uso: python3 scripts/ci/mutants_comprar_noindex.py [raiz-do-repo]
"""
import os, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
TEST = "tests/comprar-noindex.test.mjs"
COPY_DIRS = ["worker", "sales-public", "data"]
COPY_FILES = [TEST, "sales-overlay/robots.txt", "sitemap.xml"]
W = "worker/sales-public-worker.mjs"

# id -> (arquivo, trecho original (ocorre 1 vez), substituto, asserção que precisa falhar)
M = {
    "M1 header removed on the 303 redirect path": (W, 'headers.set("x-robots-tag",COMPRAR_ROBOTS);',
        'if(response.status!==303)headers.set("x-robots-tag",COMPRAR_ROBOTS);', "[x-robots-tag]"),
    "M2 header removed on the 404 path": (W, 'headers.set("x-robots-tag",COMPRAR_ROBOTS);',
        'if(response.status!==404)headers.set("x-robots-tag",COMPRAR_ROBOTS);', "[x-robots-tag]"),
    "M3 header weakened to noindex only": (W, 'export const COMPRAR_ROBOTS="noindex, nofollow";',
        'export const COMPRAR_ROBOTS="noindex";', "[x-robots-tag]"),
    "M4 no-store removed on the 405 path": (W, 'headers.set("cache-control","no-store");\n  applySecurityHeaders(headers);\n  let body',
        'if(response.status!==405)headers.set("cache-control","no-store");\n  applySecurityHeaders(headers);\n  let body', "[cache-control]"),
    "M5 robots meta removed from HTML": (W, 'html=/<meta name="robots"[^>]*>/i.test(html)?html.replace(/<meta name="robots"[^>]*>/gi,COMPRAR_META):html.replace(/<head>/i,"<head>"+COMPRAR_META);',
        'html=html.replace(/<meta name="robots"[^>]*>/gi,"");', "[meta]"),
    "M6 robots meta left as noindex (no nofollow)": (W, 'html=/<meta name="robots"[^>]*>/i.test(html)?',
        'html=true?html:/<meta name="robots"[^>]*>/i.test(html)?', "[meta]"),
    "M7 non-SKU /comprar paths fall through to assets": (W, 'export const COMPRAR_PATH=/^\\/comprar(?:\\/|$)/i;',
        'export const COMPRAR_PATH=/^\\/comprar\\/[A-Z0-9-]{6,20}\\/?$/i;', "[x-robots-tag]"),
    "M8 exception escapes without headers": (W, 'console.error("buy_route_error",String(e&&e.message||e).slice(0,80));',
        'throw e;', "[exception]"),
    "M9 uppercase /COMPRAR not covered": (W, 'export const COMPRAR_PATH=/^\\/comprar(?:\\/|$)/i;',
        'export const COMPRAR_PATH=/^\\/comprar(?:\\/|$)/;', "[x-robots-tag]"),
    "M10 sales sitemap includes /comprar/": ("sales-public/sitemap.xml", "</urlset>",
        "<url><loc>https://vendas.zevanory.api.br/comprar/ZEV-IA-011</loc></url></urlset>", "[sitemap:sales-public/sitemap.xml]"),
    "M11 apex sitemap includes /comprar/": ("sitemap.xml", "</urlset>",
        "<url><loc>https://zevanory.api.br/comprar/ZEV-NGC-011</loc></url></urlset>", "[sitemap:sitemap.xml]"),
    "M12 robots.txt re-adds Disallow /comprar/": ("sales-public/robots.txt", "Allow: /\n",
        "Allow: /\nDisallow: /comprar/\n", "[robots:sales-public/robots.txt]"),
    "M13 overlay robots.txt re-adds wildcard Disallow": ("sales-overlay/robots.txt", "Allow: /\n",
        "Allow: /\nDisallow: /*comprar\n", "[robots:sales-overlay/robots.txt]"),
    "M14 canonical points to /comprar/": ("sales-public/ia-na-pratica.html", '<link rel="canonical" href="https://vendas.zevanory.api.br/ia-na-pratica">',
        '<link rel="canonical" href="https://vendas.zevanory.api.br/comprar/ZEV-IA-011">', "[canonical]"),
}


def sub(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new, 1)


def stage(d):
    for x in COPY_DIRS:
        if (REPO / x).is_dir():
            shutil.copytree(REPO / x, Path(d) / x, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for x in COPY_FILES:
        (Path(d) / x).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / x, Path(d) / x)


def run(d):
    return subprocess.run(["node", "--test", TEST], cwd=d, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=600)


def one(item):
    name, (fname, old, new, expect) = item
    with tempfile.TemporaryDirectory() as d:
        stage(d)
        f = Path(d) / fname
        f.write_text(sub(f.read_text(encoding="utf-8"), old, new), encoding="utf-8")
        p = run(d)
    out = p.stdout + p.stderr
    return name, p.returncode != 0 and "not ok" in out and expect in out, expect


with tempfile.TemporaryDirectory() as d0:
    stage(d0)
    base = run(d0)
if base.returncode != 0:
    print(base.stdout[-3000:])
    print("MUTANT BASELINE FAILED (suíte sem mutação não passa)")
    sys.exit(2)
print("MUTANT BASELINE PASS", flush=True)
survivors = 0
with ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2)) as ex:
    for name, killed, expect in ex.map(one, M.items()):
        mid = name.split()[0]
        survivors += 0 if killed else 1
        print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} — {name[len(mid) + 1:]} (asserção: {expect})", flush=True)
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
