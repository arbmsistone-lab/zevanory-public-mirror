#!/usr/bin/env python3
"""Mutantes causais do P03 (auditoria de TODAS as páginas de sales-public/): scripts/audit/p03-pages-static.mjs,
scripts/audit/p03-pages-browser.mjs e a própria saída gerada (regressão das correções), classificados pelo
classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p03-pages-audit.test.mjs (P1-P9, estática, árvore real e
páginas mínimas) e tests/ci/p03-pages-browser.test.mjs (N1-N10, Chromium + axe-core de $QUALITY_MODULES; sem
eles a baseline FALHA, nunca pula). Cada mutante altera UMA regra numa cópia mínima da árvore em diretório
temporário (o repositório nunca é alterado).
Expectativas (mutants_p03_pages_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Pn.k]/[Nn.k]) e secondary com justification, escritas por raciocínio sobre
a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary sem marcador,
test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: QUALITY_MODULES=/caminho/node_modules python3 scripts/ci/mutants_p03_pages.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p03-pages-audit.test.mjs", "tests/ci/p03-pages-browser.test.mjs"]
COPY_DIRS = ["sales-public"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "scripts/audit/p03-pages-static.mjs", "scripts/audit/p03-pages-browser.mjs",
                      "scripts/build_sales_public.py", "worker/sales-public-worker.mjs", "data/products.json",
                      # P10 importa o Worker real, que importa estes (e data/politica-unica.json).
                      "worker/politica-unica.mjs", "worker/nc015-sales-scope.mjs", "data/politica-unica.json"]
TIMEOUT = 600
NODE = shutil.which("node") or "node"
A = "scripts/audit/p03-pages-static.mjs"
B = "scripts/audit/p03-pages-browser.mjs"

M = {
    "M01 arquivo fora do inventário aceito": (A, "  if (extra.length) problems.push(", "  if (false) problems.push("),
    "M02 rotas do Worker não comparadas": (A, "  if (JSON.stringify(w) !== JSON.stringify(r)) problems.push(", "  if (false) problems.push("),
    "M03 lang não conferido": (A, '  if (attr(htmlTag, "lang") !== "pt-BR")', "  if (false)"),
    "M04 vários h1 aceitos": (A, '  if (h1 !== 1) p("S05"', '  if (h1 < 1) p("S05"'),
    "M05 viewport não conferido": (A, '  if (!tags(html, "meta").some(', '  if (false && !tags(html, "meta").some('),
    "M06 skip-link não exigido": (A, '    if (!skip) p("S08"', '    if (!skip) void ("S08"'),
    "M07 banner não exigido": (A, '    if (!/<header\\b/.test(html)) p("S09"', '    if (false) p("S09"'),
    "M08 link interno quebrado aceito": (A, '    if (!r.ok) p("S10"', '    if (false) p("S10"'),
    "M09 âncora local não conferida": (A, '{ frag = href.slice(1); if (frag && !own.has(frag)) p("S10"', '{ frag = href.slice(1); if (false) p("S10"'),
    "M10 canonical não conferida": (A, '      if (canon[0] !== want) p("S11"', '      if (false) p("S11"'),
    "M11 og:url não conferido": (A, "      if (og.length && og[0] !== canon[0])", "      if (false)"),
    "M12 description repetida aceita": (A, '      if (d) { if (seenD.has(d)) p("S12"', '      if (d) { if (false) p("S12"'),
    "M13 title repetido aceito": (A, '    if (t) { if (seenT.has(t)) p("S04"', '    if (t) { if (false) p("S04"'),
    "M14 indexável fora do sitemap aceita": (A, '    if (!locs.has(c)) p("S18"', '    if (false) p("S18"'),
    "M15 preço citado fora da tabela C aceito": (A, '      if (!allowed.has(v)) p("S13"', '      if (false) p("S13"'),
    "M16 preço de tabela da página não conferido": (A, '    if (!m || +m[1] !== TABLE_C[slug][1]) p("S13"', '    if (false) p("S13"'),
    "M17 aviso de vendas fechadas não exigido": (A, '  if (hasCta && !/<p class="sales-notice"', '  if (false && !/<p class="sales-notice"'),
    "M18 avaliação no texto aceita": (A, "  if (/★|☆", "  if (false && /★|☆"),
    "M19 preço de/por aceito": (A, "  if (/\\bde R\\$", "  if (false && /\\bde R\\$"),
    "M20 PRICES do Worker não conferido": (A, '    if (site.workerPrices[name] !== price) p("S19"', '    if (false) p("S19"'),
    "M21 tabela C com preço errado": (A, '"ia-na-pratica": ["IA na Prática", 97]', '"ia-na-pratica": ["IA na Prática", 87]'),
    "M22 axe só critical": (B, '    for (const v of axe) if (v.impact === "serious" || v.impact === "critical") p("B02"', '    for (const v of axe) if (v.impact === "critical") p("B02"'),
    "M23 rolagem horizontal aceita": (B, '    if (ov.scrollWidth > ov.clientWidth + 1) p("B03"', '    if (false) p("B03"'),
    "M24 alvo mínimo reduzido": (B, "export const MIN_TARGET = 24;", "export const MIN_TARGET = 10;"),
    "M25 skip-link não seguido até o main": (B, '    if (!(tgt || next.inMain)) problems.push(["B05"', '    if (false) problems.push(["B05"'),
    "M26 foco sem indicador aceito": (B, "    if (!cur.ring) noRing.push(cur.label);\n", ""),
    "M27 tabindex positivo aceito": (B, '  if (expected.positive) problems.push(["B07"', '  if (false) problems.push(["B07"'),
    "M28 sequência de Tab não conferida": (B, "      else { if (n < last) order.push(", "      else { if (false) order.push("),
    "M29 armadilha de teclado não detectada": (B, '  if (repeats >= 2) problems.push(["B08", "armadilha', '  if (false) problems.push(["B08", "armadilha'),
    "M30 erro de console ignorado": (B, '    if (ce.length) p("B09"', '    if (false) p("B09"'),
    "M31 status HTTP não conferido": (B, '    if (status !== expectStatus) p("B01"', '    if (false) p("B01"'),
    "M32 regressão: jurídica sem skip-link": ("sales-public/termos.html", '<body><a class="skip-link" href="#conteudo">Ir para o conteúdo</a>', "<body>"),
    "M33 regressão: rota prevista sem página": ("scripts/build_sales_public.py", '    "como-mandar-orcamento-pelo-whatsapp",\n)', '    "como-mandar-orcamento-pelo-whatsapp",\n    "pagina-fantasma",\n)'),
    "M34 regressão: rodapé sem nome acessível": ("sales-public/solucoes.html", '<nav class="footer-nav" aria-label="Rodapé">', '<nav class="footer-nav">'),
    # O3: canonical = endereço servido (/slug, 200, sem redirect).
    "M35 canonical com barra final aceita": (A, '      if (canon[0] !== want) p("S11"', '      if (canon[0] !== want && canon[0] !== want + "/") p("S11"'),
    "M36 regressão: quem-criou com canonical em barra": ("sales-public/quem-criou.html", '<link rel="canonical" href="https://vendas.zevanory.api.br/quem-criou">', '<link rel="canonical" href="https://vendas.zevanory.api.br/quem-criou/">'),
    "M37 canonical diferente do caminho servido aceita (navegador)": (B, '      if (cp !== want) p("B10"', '      if (false) p("B10"'),
    "M38 página servida com redirect aceita": (B, '    if (from) p("B10"', '    if (false) p("B10"'),
    "M39 canonical que não responde 200 aceita": (B, '      if (cr.status() !== 200 || cr.headers()["location"]) p("B10"', '      if (false) p("B10"'),
    # O2: aviso que nunca mente em toda página com preço da tabela C.
    "M40 aviso de disponibilidade não exigido": (A, '    if (!m) p("S20"', '    if (!m) void ("S20"'),
    "M41 data-zev-closed fora do interruptor aceito": (A, '  if (/\\sdata-zev-closed\\b/.test(html) && !toggled) p("S21"', '  if (false) p("S21"'),
    "M42 texto do aviso de disponibilidade não conferido": (A, "    else if (!noteTextOk(m[1])) p(", "    else if (false) p("),
    "M43 página do interruptor sem aviso de fechadas aceita": (A, "  if (priced && toggled && !/<p class=\"sales-notice\"", "  if (false && priced && toggled && !/<p class=\"sales-notice\""),
    "M44 regressão: ramo com preço sem aviso": ("sales-public/ia-para-academia.html", '<p class="price-note">', '<p class="price-note-x">'),
    "M45 regressão: /index.html servido cru pelo Worker": ("worker/sales-public-worker.mjs", '  else if(url.pathname==="/index.html") { url.pathname="/solucoes.html"; page="solucoes"; }\n', ""),
    "M46 regressão: Worker não remove o aviso de fechadas ao abrir": ("worker/sales-public-worker.mjs", '  out=out.replace(/<(p|span)\\b[^>]*\\sdata-zev-closed[^>]*>[^<]*<\\/\\1>/g,"");\n', ""),
}

ALLOW_FILE = Path(os.environ.get("P03_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p03_pages_allow.json"))


def load_config(path=None, titles=None, mutants=None):
    raw = json.loads(Path(path or ALLOW_FILE).read_text(encoding="utf-8"))
    specs = raw.get("mutants") if isinstance(raw, dict) else None
    if not isinstance(specs, dict):
        raise mc.ConfigError("config sem a seção 'mutants'")
    cfg = mc.load_mutant_config(specs)
    mutants = M if mutants is None else mutants
    missing, orphan = sorted(set(mutants) - set(cfg)), sorted(set(cfg) - set(mutants))
    if missing or orphan:
        raise mc.ConfigError(f"mutantes sem config {missing} / config órfã {orphan}")
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        if titles is not None:
            for e in spec["primary"] + spec["secondary"]:
                if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                    raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern'][:60]}")
    return cfg


def build(tmp, mutation=None):
    for rel in COPY_DIRS:
        shutil.copytree(Path(REPO, *rel.split("/")), Path(tmp, *rel.split("/")), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for rel in COPY_FILES:
        dst = Path(tmp, *rel.split("/"))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(REPO, *rel.split("/")), dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp, *rel.split("/"))
        text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "PYTHONDONTWRITEBYTECODE": "1"}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    total = parsed["summary"].get("tests")
    vb = mc.validate_baseline(total if isinstance(total, int) else -1, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        print(base.get("stdout", "")[-3000:])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={total}")
    try:
        cfg = load_config(titles=titles)
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(item):
        name, mutation = item
        res = run_mutant(name, mutation, total, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, mutation, total, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
