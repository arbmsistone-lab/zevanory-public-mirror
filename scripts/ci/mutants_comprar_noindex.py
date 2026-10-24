#!/usr/bin/env python3
"""Mutantes /comprar/ noindex (auditor Sol, AVAL 100/AVAL #888): cada mutante altera UMA CÓPIA temporária do Worker de
vendas, do sitemap, do robots.txt ou de uma página publicada, roda tests/comprar-noindex.test.mjs contra a cópia e
classifica o resultado. Determinístico em Linux e Windows (Node 22/24):
  - texto lido em UTF-8 com CRLF normalizado para LF (mesma regra de tests/helpers/text.mjs, readTextNormalized) antes de
    aplicar a mutação, e o arquivo mutado é gravado em UTF-8 com LF; caminhos sempre por pathlib (sem "/" literal no SO);
  - node resolvido por shutil.which, lista de argumentos sem shell, stdin fechado, saída decodificada em UTF-8;
  - reporter TAP explícito (--test-reporter=tap): no Node >= 23 o reporter padrão é "spec" mesmo fora de TTY, e a
    detecção por "not ok" via spec produzia SOBREVIVENTE falso.
Classificação (nunca por "qualquer falha"):
  KILLED       exit != 0, TAP com "not ok" E o rótulo da asserção esperada na saída;
  SURVIVED     exit == 0 e resumo TAP completo "# tests N / # pass N / # fail 0" (N = baseline);
  INCONCLUSIVE qualquer outra coisa: trecho a mutar não encontrado, node ausente, timeout, erro de SO, saída sem resumo
               TAP, ou falha sem o rótulo esperado (erro de infraestrutura não conta como morto nem como sobrevivente).
Saída: `MUTANT <id> KILLED|SURVIVED|INCONCLUSIVE`. Exit 0 só se todos KILLED; 1 se algum SURVIVED; 3 se algum
INCONCLUSIVE (sem sobrevivente); 2 se a baseline (sem mutação) não passar.
Uso: python3 scripts/ci/mutants_comprar_noindex.py [raiz-do-repo]
"""
import os, re, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
TEST = Path("tests", "comprar-noindex.test.mjs")
COPY_DIRS = [Path("worker"), Path("sales-public"), Path("data")]
COPY_FILES = [TEST, Path("tests", "helpers", "text.mjs"), Path("sales-overlay", "robots.txt"), Path("sitemap.xml")]
W = "worker/sales-public-worker.mjs"
NODE = shutil.which("node")
TIMEOUT = 600

# id -> (arquivo relativo com "/", trecho original (ocorre 1 vez após normalizar EOL), substituto, rótulo da asserção esperada)
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
    "M15 path not decoded before matching": (W, 'const once=percentDecodeOnce(pathname);', 'const once=pathname;', "[alias]"),
    "M16 multi-encoded aliases not covered": (W, 'for(let i=0;i<3;i++){const n=percentDecodeOnce(p);', 'for(let i=0;i<0;i++){const n=percentDecodeOnce(p);', "[double]"),
    "M17 uppercase hex escapes not decoded": (W, 'const hex=b=>(b>=48&&b<=57)||(b>=65&&b<=70)||(b>=97&&b<=102);', 'const hex=b=>(b>=48&&b<=57)||(b>=97&&b<=102);', "[alias]"),
    "M18 double-encoded alias routed to the buy flow": (W, 'return {path:p,routable:false};', 'return {path:p,routable:true};', "[double]"),
}


def read_text_normalized(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def write_lf(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def stage(d):
    for x in COPY_DIRS:
        if (REPO / x).is_dir():
            shutil.copytree(REPO / x, d / x, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for x in COPY_FILES:
        (d / x).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / x, d / x)


def run(d):
    env = {**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": ""}
    p = subprocess.run([NODE, "--test", "--test-reporter=tap", TEST.as_posix()], cwd=str(d), env=env,
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
    out = (p.stdout + p.stderr).decode("utf-8", errors="replace").replace("\r\n", "\n")
    return p.returncode, out


def summary(out):
    get = lambda k: (re.search(rf"^# {k} (\d+)$", out, re.M) or [None, None])[1]
    return {k: get(k) for k in ("tests", "pass", "fail")}


def classify(rc, out, expect, total):
    s = summary(out)
    if rc != 0 and re.search(r"^\s*not ok ", out, re.M) and expect in out:
        return "KILLED", ""
    if rc == 0 and s == {"tests": total, "pass": total, "fail": "0"}:
        return "SURVIVED", ""
    return "INCONCLUSIVE", f"rc={rc} resumo={s} rótulo_presente={expect in out}"


def one(item, total):
    name, (fname, old, new, expect) = item
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            d = Path(tmp)
            stage(d)
            f = d.joinpath(*fname.split("/"))
            text = read_text_normalized(f)
            if text.count(old) != 1:
                return name, "INCONCLUSIVE", f"trecho a mutar ocorre {text.count(old)} vez(es)", expect
            write_lf(f, text.replace(old, new, 1))
            rc, out = run(d)
        verdict, why = classify(rc, out, expect, total)
        return name, verdict, why, expect
    except (OSError, subprocess.SubprocessError, UnicodeError) as e:
        return name, "INCONCLUSIVE", f"erro de infraestrutura: {type(e).__name__}: {e}", expect


def main():
    if not NODE:
        print("MUTANT BASELINE INCONCLUSIVE (node ausente no PATH)")
        return 3
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            stage(Path(tmp))
            rc, out = run(Path(tmp))
    except (OSError, subprocess.SubprocessError) as e:
        print(f"MUTANT BASELINE INCONCLUSIVE ({type(e).__name__}: {e})")
        return 3
    s = summary(out)
    if rc != 0 or not s["tests"] or s["pass"] != s["tests"] or s["fail"] != "0":
        print(out[-3000:])
        print(f"MUTANT BASELINE FAILED (suíte sem mutação não passa) rc={rc} resumo={s}")
        return 2
    total = s["tests"]
    print(f"MUTANT BASELINE PASS tests={total} node={subprocess.run([NODE, '--version'], capture_output=True, text=True).stdout.strip()} os={os.name}", flush=True)
    counts = {"KILLED": 0, "SURVIVED": 0, "INCONCLUSIVE": 0}
    with ThreadPoolExecutor(max_workers=max(2, min(8, os.cpu_count() or 2))) as ex:
        for name, verdict, why, expect in ex.map(lambda it: one(it, total), M.items()):
            mid = name.split()[0]
            counts[verdict] += 1
            extra = f" [{why}]" if why else ""
            print(f"MUTANT {mid} {verdict} — {name[len(mid) + 1:]} (asserção: {expect}){extra}", flush=True)
    print(f"MUTANTS_TOTAL={len(M)} KILLED={counts['KILLED']} SURVIVED={counts['SURVIVED']} INCONCLUSIVE={counts['INCONCLUSIVE']}")
    return 1 if counts["SURVIVED"] else 3 if counts["INCONCLUSIVE"] else 0


if __name__ == "__main__":
    sys.exit(main())
