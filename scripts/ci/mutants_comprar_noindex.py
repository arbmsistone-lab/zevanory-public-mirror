#!/usr/bin/env python3
"""Mutantes /comprar/ noindex (auditor Sol, AVAL 100/AVAL #888): cada mutante altera UMA CÓPIA temporária do Worker de
vendas, do sitemap, do robots.txt ou de uma página publicada, roda tests/comprar-noindex.test.mjs contra a cópia e
classifica o resultado. Determinístico em Linux e Windows (Node 22/24):
  - texto lido em UTF-8 com CRLF normalizado para LF (mesma regra de tests/helpers/text.mjs, readTextNormalized) antes de
    aplicar a mutação, e o arquivo mutado é gravado em UTF-8 com LF; caminhos sempre por pathlib (sem "/" literal no SO);
  - node resolvido por shutil.which, lista de argumentos sem shell, stdin fechado, saída decodificada em UTF-8;
  - reporter TAP explícito (--test-reporter=tap): no Node >= 23 o reporter padrão é "spec" mesmo fora de TTY, e a
    detecção por "not ok" via spec produzia SOBREVIVENTE falso.
Classificação (AVAL Sol 125; mesma disciplina do classificador B05 de mutants_mp_webhook.py, nunca "qualquer falha"):
  KILLED       exit == 1, TAP COMPLETO (plano "1..N" e resumo tests/pass/fail/cancelled/skipped/todo) com total igual
               ao da baseline, cancelled/skipped/todo = 0, pelo menos um bloco "not ok" de topo com falha de ASSERÇÃO
               (ERR_ASSERTION) que contém o rótulo esperado DENTRO do bloco, e TODA outra falha também é asserção com
               um rótulo esperado do mutante;
  SURVIVED     exit == 0 e TAP completo, limpo, com total = baseline e fail = 0;
  INCONCLUSIVE todo o resto: trecho a mutar não encontrado, node ausente, timeout, sinal, erro de SO, crash
               (SyntaxError/TypeError/ReferenceError, módulo ausente, Traceback) fora de bloco de asserção, TAP
               truncado ou sem resumo, contagem diferente da baseline, falha extra não esperada, falha sem asserção,
               rótulo só fora do bloco, skip/todo/cancelled inesperado. Rótulos são casados como token exato entre
               colchetes ("[T1]" nunca casa "[T10]"). Meta-testes: tests/test_mutants_comprar_classifier.py.
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

# id -> (arquivo relativo com "/", trecho original (ocorre 1 vez após normalizar EOL), substituto, rótulo PRIMÁRIO).
# Regra Sol 128: o rótulo primário vem do raciocínio sobre a mutação (a asserção que testa DIRETAMENTE a regra
# mutada), nunca de quais testes falharam. Secundários ficam em SECONDARY com justificativa causal de uma linha.
# Tabela de causalidade: docs/evidence/mutants_comprar_noindex-mutant-causality.md.
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
    # AVAL Sol #892 (WhatsApp banido): oráculo cruzado no corpo de /comprar.
    "M19 wa.me injected only in the alias/unknown-path 404": (W, '    return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado.</p>");\n  }catch(e){',
        '    return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado. <a href=\\"https://wa.me/5588992545413\\">WhatsApp</a></p>");\n  }catch(e){', "[whatsapp]"),
    "M20 masked banned number only in the unknown-SKU 404": (W, 'if(!slug) return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado.</p>");',
        'if(!slug) return infoPage(404,"Produto não encontrado","<p>Esse produto não existe ou foi retirado. Ligue (88) 99254-5413.</p>");', "[whatsapp]"),
    "M21 WhatsApp channel phrase only in the exception 503": (W, 'return infoPage(503,"Checkout indisponível","<p>Tente novamente em instantes.</p>");',
        'return infoPage(503,"Checkout indisponível","<p>Tente novamente em instantes ou fale no WhatsApp: suporte humano no WhatsApp.</p>");', "[whatsapp]"),
}

# PRIMÁRIO extra (além do rótulo da tupla em M; total 1–3 por mutante) e SECUNDÁRIOS {rótulo: justificativa}.
PRIMARY_EXTRA = {}
SECONDARY = {
    "M9": {"[alias]": "o alias percent-encoded /%43OMPRAR decodifica para /COMPRAR, que a regex sem flag i deixa de casar; o teste de aliases falha no status antes do cabeçalho"},
}
MAP = {}  # preenchido por main() a partir de mutant_map()
BROAD_REASON = {}  # mutante com mais de 4 asserções listadas precisa de justificativa ampla aqui


def mutant_map(m=None, primary_extra=None, secondary=None, broad=None):
    """-> {id: (primários, {secundário: justificativa})}. Recusa iniciar (ValueError) se o mapa violar a regra Sol 128."""
    m = M if m is None else m
    primary_extra = PRIMARY_EXTRA if primary_extra is None else primary_extra
    secondary = SECONDARY if secondary is None else secondary
    broad = BROAD_REASON if broad is None else broad
    ids = {name.split()[0] for name in m}
    out, problems = {}, []
    for key in set(primary_extra) | set(secondary) | set(broad):
        if key not in ids:
            problems.append(f"{key}: entrada para mutante inexistente")
    for name, entry in m.items():
        mid = name.split()[0]
        prim = (entry[3], *primary_extra.get(mid, ()))
        sec = dict(secondary.get(mid, {}))
        if not 1 <= len(prim) <= 3:
            problems.append(f"{mid}: {len(prim)} primários (exige 1 a 3)")
        for label, why in sec.items():
            if not isinstance(why, str) or len(why.strip()) < 15:
                problems.append(f"{mid}: secundário {label} sem justificativa causal")
            if label in prim:
                problems.append(f"{mid}: {label} é primário e secundário")
        if len(prim) + len(sec) > 4 and not str(broad.get(mid, "")).strip():
            problems.append(f"{mid}: {len(prim) + len(sec)} asserções listadas sem broad_reason")
        out[mid] = (prim, sec)
    if problems:
        raise ValueError("MAPA_DE_MUTANTES_INVALIDO " + "; ".join(sorted(problems)))
    return out


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


SUMMARY_KEYS = ("tests", "pass", "fail", "cancelled", "skipped", "todo")
ASSERT_RE = re.compile(r"^\s+code: '?ERR_ASSERTION'?$|^\s+name: '?AssertionError'?$", re.M)
CRASH_RE = re.compile(r"SyntaxError|ReferenceError|TypeError|ERR_MODULE_NOT_FOUND|Cannot find module|"
                      r"Traceback \(most recent call last\)|ERR_UNHANDLED|Segmentation fault|FATAL ERROR")
# Bloco de falha TAP de topo: "not ok N - nome" até a linha "  ..." que fecha o YAML do bloco.
FAIL_BLOCK = re.compile(r"^not ok \d+ - (?P<name>[^\n]*)\n(?P<body>(?:[ \t]+[^\n]*\n|\n)*?)  \.\.\.$", re.M)


def summary(out):
    get = lambda k: (re.search(rf"^# {k} (\d+)$", out, re.M) or [None, None])[1]
    return {k: get(k) for k in SUMMARY_KEYS}


def label_in(label, body):
    """Rótulo como token exato: "[T1]" não casa "[T10]" nem "[T1x]"."""
    return label in body if label.startswith("[") and label.endswith("]") else re.search(rf"(?<![\w-]){re.escape(label)}(?![\w-])", body) is not None


def classify(rc, out, expect, total, secondary=()):
    """-> (KILLED|SURVIVED|INCONCLUSIVE, motivo). expect: rótulo(s) PRIMÁRIO(s); secondary: rótulos justificados.
    KILLED exige ao menos uma falha de asserção com rótulo primário; toda outra falha precisa ser primária ou
    secundária justificada."""
    primary = [expect] if isinstance(expect, str) else list(expect)
    secondary = list(secondary)
    s = summary(out)
    plan = re.search(r"^1\.\.(\d+)$", out, re.M)
    if rc is None or rc < 0:
        return "INCONCLUSIVE", f"sinal_ou_timeout rc={rc}"
    if not plan or any(v is None for v in s.values()):
        return "INCONCLUSIVE", f"tap_incompleto plano={bool(plan)} resumo={s}"
    n = {k: int(v) for k, v in s.items()}
    if n["tests"] != int(total) or n["pass"] + n["fail"] != n["tests"]:
        return "INCONCLUSIVE", f"contagem_diferente_da_baseline resumo={s} baseline={total}"
    if n["cancelled"] or n["skipped"] or n["todo"]:
        return "INCONCLUSIVE", f"skip_todo_cancelled resumo={s}"
    blocks = list(FAIL_BLOCK.finditer(out))
    nested = re.findall(r"^[ \t]+not ok \d+ - ", out, re.M)
    if rc == 0:
        if n["fail"] == 0 and not blocks and not nested and n["pass"] == int(total):
            return "SURVIVED", ""
        return "INCONCLUSIVE", f"rc0_com_falha resumo={s}"
    if rc != 1:
        return "INCONCLUSIVE", f"rc_{rc}_nao_e_falha_de_teste"
    if not blocks or len(blocks) != n["fail"] or nested:
        return "INCONCLUSIVE", f"falhas_tap_inconsistentes blocos={len(blocks)} fail={n['fail']} aninhadas={len(nested)}"
    outside = FAIL_BLOCK.sub("", out)
    crash = CRASH_RE.search(outside)
    if crash:
        return "INCONCLUSIVE", f"crash_fora_de_bloco:{crash.group(0)}"
    killed_by, unexpected = [], []
    for b in blocks:
        body = b.group("body")
        if not ASSERT_RE.search(body):
            unexpected.append(b.group("name")[:40] + ":sem_assercao")
        elif any(label_in(l, body) for l in primary):
            killed_by.append(b.group("name")[:40])
        elif not any(label_in(l, body) for l in secondary):
            unexpected.append(b.group("name")[:40] + ":rotulo_ausente_no_bloco")
    if unexpected:
        return "INCONCLUSIVE", "falha_nao_esperada:" + ";".join(unexpected)
    if not killed_by:
        return "INCONCLUSIVE", "so_falha_secundaria"
    return "KILLED", ""


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
        prim, sec = MAP[name.split()[0]]
        verdict, why = classify(rc, out, prim, total, tuple(sec))
        return name, verdict, why, expect
    except subprocess.TimeoutExpired:
        return name, "INCONCLUSIVE", f"timeout {TIMEOUT}s", expect
    except (OSError, subprocess.SubprocessError, UnicodeError) as e:
        return name, "INCONCLUSIVE", f"erro de infraestrutura: {type(e).__name__}: {e}", expect


def main():
    global MAP
    try:
        MAP = mutant_map()
    except ValueError as e:
        print(f"MUTANT MAP REFUSED {e}")
        return 4
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
