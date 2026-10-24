#!/usr/bin/env python3
"""Mutantes do Funil v2 (vendas multimeios, lista de espera, intenção real, conversões, Hotmart P0), classificados
pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (#901), sem modificação.

  suíte unit  tests/funnel-counting.test.mjs                         (21 testes, sem rede)
  suíte pg    tests/integration/funnel-own-sales-postgres.test.mjs     (4 testes, PostgreSQL real: T4_PG_HOST/T4_PG_PORT)

Expectativas: scripts/ci/mutants_funnel_v2_config.json, seções "unit"/"pg" -> "mutants" no formato de
load_mutant_config. Por mutante, 1–3 PRIMÁRIAS = teste + marcador NÃO nulo da asserção ([FUnn.k] na suíte unit,
[FPn.k] na pg), conferido dentro do bloco `not ok` daquele teste; SECUNDÁRIAS só com justificativa escrita; mais de
4 testes exige broad_reason. As expectativas foram escritas por RACIOCÍNIO sobre cada mutação (qual regra quebra,
qual asserção a codifica e é a primeira a falhar no teste), antes de rodá-la — nunca copiando falhas observadas.

Ordem (fail-closed):
  1. config carregada e validada por load_mutant_config + regras deste runner (primária sem marcador, mutante sem
     config, config órfã, sem descrição da mudança) ANTES de rodar qualquer coisa  -> exit 2 (CONFIG_INVALID);
  2. baseline sem mutação: SURVIVED pelo classificador e total fixado (21 / 4); cada test_pattern casa com
     exatamente 1 teste da baseline                                                   -> exit 2;
  3. cada mutante numa cópia temporária (o original nunca é tocado); âncora não única => INCONCLUSIVE.
KILLED só com asserção PRIMÁRIA casada; falha só em secundária, falha não relacionada, outra asserção do teste
primário, queda/sintaxe/timeout/sinal, todo/skip, TAP truncado ou contagem incoerente => INCONCLUSIVE.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit (aggregate): 0 todos KILLED; 1 SURVIVED; 2 baseline/config;
3 INCONCLUSIVE.
O resumo do Node 24 no reporter spec ("ℹ skipped 0") e o TAP ("# skipped 0") são lidos pelo parser compartilhado; o
reporter é forçado a TAP de qualquer forma.

Uso: python3 scripts/ci/mutants_funnel_v2.py [--suite unit|pg|all] [raiz-do-repo]
     python3 scripts/ci/mutants_funnel_v2.py --write-doc   (gera docs/evidence/funnel-v2-mutant-causality.md)
FUNNEL_MUTANTS_UNIT_ONLY=1 (jobs sem PostgreSQL, ex.: Windows) equivale a --suite unit.
"""
import json
import os
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (#901, sem modificação)

HERE = Path(__file__).resolve().parent
CONFIG_FILE = Path(os.environ.get("FUNNEL_MUTANTS_CONFIG") or HERE / "mutants_funnel_v2_config.json")
DOC_FILE = "docs/evidence/funnel-v2-mutant-causality.md"
COPY = ["worker", "scripts/audit", "scripts/channels", "data", "db/migrations", "sales-public/material-gratuito.html",
        "tests/funnel-counting.test.mjs", "tests/helpers", "scripts/ci/mutants_funnel_v2.py", ".github/workflows/funnel-v2.yml",
        "tests/integration/funnel-own-sales-postgres.test.mjs"]
FC, SNAP, INV = "scripts/audit/funnel-counting.mjs", "scripts/audit/command-center-snapshot.mjs", "scripts/audit/autonomy-inventory.mjs"
FUN, SPW = "worker/funnel.mjs", "worker/sales-public-worker.mjs"
SUITES = {
    "unit": {"test": "tests/funnel-counting.test.mjs", "total": 21, "timeout": 300},
    "pg": {"test": "tests/integration/funnel-own-sales-postgres.test.mjs", "total": 4, "timeout": 600},
}
NODE = shutil.which("node") or "node"
# Assembled at runtime so this file itself carries no contact link (the unit suite scans it).
BANNED_LINK = "wa" + ".me/" + "558899" + "2545413"
_MARKERS = 'export const OWN_MARKERS = Object.freeze(["paidWithoutConfirmedEvent", "statusMismatch", "confirmedEventWithoutOrder", "extraOrdersSameSession"]);'

M_UNIT = {
    "F1 rótulo Hotmart no ledger próprio é contado": (FC, "if (!OWN_PROVIDERS.includes(provider)) { out.ignoredNonOwnProvider += n(b?.confirmed); continue; }", ""),
    "F2 checkout próprio ausente vira zero": (FC, 'const ownTotal = os === "counted" ? o.total : os === "test_mode" ? 0 : null;', 'const ownTotal = os === "counted" ? o.total : 0;'),
    "F3 Hotmart sem postback tratada como ledger completo": (FC, '(sales && sales.schema === "zevanory-sales/v1" ? "ledger" : "no_events")', '"ledger"'),
    "F4 clique de lista contado sem instrumentação": (FC, "const wlClick = v2 && clickInstrumented ?", "const wlClick = v2 ?"),
    "F5 intenção contada em dias fechados": (FC, "value: v2 && open30.length ? ocs : null", "value: v2 ? ocs : null"),
    "F6 série antiga reclassificada como completa": (FC, 'integrityClass: "LEGACY_MIXED", label: "Série antiga', 'integrityClass: "COMPLETE", label: "Série antiga'),
    "F7 conversão visitante→venda usa dias fechados": (FC, "open30.reduce((a, d) => a + n(daily[d]?.site_visitors), 0)", "d30.reduce((a, d) => a + n(daily[d]?.site_visitors), 0)"),
    "F8 leads confirmados somam pendentes": (FC, "value: lc ?? null", "value: funnel?.last7Days?.leads ?? null"),
    "F9 sonda inconclusiva vira aceitando": (FC, 'return p.offerMarker ? "accepting" : "inconclusive";', 'return "accepting";'),
    "F10 erro 049 não reconhecido": (FC, 'if (/^\\/error/i.test(String(p.finalPath || "")) || p.errorCode || p.blockedText) return "closed";', 'if (p.blockedText) return "closed";'),
    "F11 P0 não levantado com oferta aceitando": (FC, 'if (accepting.length) return { ...base, state: "p0_bypass", severity: "P0" };', ""),
    "F12 vendas fechadas esperam checkout": (FC, 'salesOpen === false ? "closed" : null', 'salesOpen === false ? "checkout" : null'),
    "F13 intenção contada antes da sessão criada": (SPW, 'const res=await env.CORE.fetch("https://checkout.internal', 'countView(request,env,ctx,slug,"own_checkout_started",{provider:"mercadopago"});const res=await env.CORE.fetch("https://checkout.internal'),
    "F14 exposição sempre como botão de compra": (SPW, '{cta:toggleOpen?"buy":"waitlist"}', '{cta:"buy"}'),
    "F15 painel volta a vendas só Hotmart": (FC, "m.sales30 = salesMetric(combineSales({ sales, own, days: s30days })", "m.sales30 = salesMetric(combineSales({ sales, own: null, days: s30days })"),
    "F16 inventário aceita P0 como prova": (INV, 'const ok = lock.state === "selling" || lock.state === "closed";', 'const ok = lock.state !== "unknown";'),
    "F17 painel recomenda levar Comprar à Hotmart": (SNAP, "      ...recommend({ funnel, reach, publications, salesKnown }),", '      { title: "x", evidence: "x", action: "Levar o botão Comprar ao checkout da Hotmart", confidence: "alta", risk: "baixo", cost: "R$ 0" },\n      ...recommend({ funnel, reach, publications, salesKnown }),'),
    "Z1 vendas desconhecidas viram 0 nos marcos": (SNAP, "const salesCount = salesKnown.value;", "const salesCount = salesKnown.value ?? 0;"),
    "Z2 parcial zero tratado como zero conhecido": (FC, ': { value: null, integrityClass: "PARTIAL", lowerBound: false };', ': { value: 0, integrityClass: "PARTIAL", lowerBound: false };'),
    "Z3 previsão extrapola com fonte faltando": (SNAP, "forecast: salesKnown.value == null || salesKnown.lowerBound ?", "forecast: false ?"),
    "Z4 recomendação sem ramo de vendas não verificadas": (SNAP, "  if (k.value == null) out.push(", "  if (false) out.push("),
    "Z5 métrica só-Hotmart volta ao snapshot": (SNAP, "      salesTotal: salesAllM,", '      salesTotal: salesAllM,\n      netTotalCents: { value: 0, source: "Hotmart (postback autenticado)" },'),
    "Z6 emissor legado checkout_intent no GET": (SPW, '  if(request.method!=="POST"){\n', '  if(request.method!=="POST"){\n    countView(request,env,ctx,slug,"checkout_intent");\n'),
    "Z7 borda UTC da Hotmart ignorada": (FC, "const cls = c.complete && !c.hotmart.edgeSales ?", "const cls = c.complete ?"),
    "Z8 visitante→venda COMPLETE com Hotmart fora do numerador": (FC, 'integrityClass: hot || num == null ? "PARTIAL" : v2Class', 'integrityClass: num == null ? "PARTIAL" : v2Class'),
    "Z9 link de contato no código novo": (FC, '"O botão leva direto a um link externo sem passar pelo site;', '"O botão leva direto a ' + BANNED_LINK + ' sem passar pelo site;'),
    "Z10 meta de receita soma limite inferior": (SNAP, "knownCount(m).lowerBound ? null : c.grossCents", "knownCount(m).lowerBound ? c.grossCents : c.grossCents"),
    "K1 marcador paidWithoutConfirmedEvent ignorado": (FC, _MARKERS, _MARKERS.replace('"paidWithoutConfirmedEvent", ', "")),
    "K2 marcador statusMismatch ignorado": (FC, _MARKERS, _MARKERS.replace('"statusMismatch", ', "")),
    "K3 marcador confirmedEventWithoutOrder ignorado": (FC, _MARKERS, _MARKERS.replace('"confirmedEventWithoutOrder", ', "")),
    "K4 marcador extraOrdersSameSession ignorado": (FC, _MARKERS, _MARKERS.replace(', "extraOrdersSameSession"', "")),
    "K5 zero parcial publicado como zero": (FC, 'const partialZero = cls === "PARTIAL" && c.total === 0;', "const partialZero = false;"),
    "K6 marcadores não exigidos para completo": (FC, 'const complete = ownTotal != null && hs === "ledger" && markers.clean;', 'const complete = ownTotal != null && hs === "ledger";'),
}
M_PG = {
    "S1 failover na mesma sessão conta 2": (FUN, "coalesce(o.session_id::text, o.order_id::text) as purchase", "o.order_id::text as purchase"),
    "S2 pedidos de certificação contam": (FUN, "where fe.normalized_event = 'payment_confirmed' and coalesce(o.certification_pilot, false) = false\n                   group by", "where fe.normalized_event = 'payment_confirmed'\n                   group by"),
    "S3 dia da venda em UTC": (FUN, "at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as day", "at time zone 'UTC', 'YYYY-MM-DD') as day"),
    "S4 intenção sem janela de 30 min": (FUN, "${Math.floor(now / INTENT_BUCKET_MS)}", "${now}"),
    "S5 visitor-days deduplicados por página": (FUN, "if (await firstTime(sql, day, SITE_PAGE, vhash))", "if (await firstTime(sql, day, page, vhash))"),
    "S6 confirmados pela data do cadastro": (FUN, "and confirmed_at >= current_date - interval '6 days')::int as confirmed", "and created_at >= current_date - interval '6 days')::int as confirmed"),
    "S7 linhas v2 em dia UTC": (FUN, 'export const v2Day = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));', "export const v2Day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);"),
}
MUTANTS = {"unit": M_UNIT, "pg": M_PG}


# ---------------------------------------------------------------- config
def load_config(path=None, titles=None, mutants=None):
    """-> {suite: normalised load_mutant_config output}. Raises mc.ConfigError on any defect.
    titles: {suite: [baseline test names]} — when given, every test_pattern must match exactly one test."""
    raw = json.loads(Path(path or CONFIG_FILE).read_text(encoding="utf-8"))
    mutants = MUTANTS if mutants is None else mutants
    out = {}
    for suite, catalog in mutants.items():
        sec = raw.get(suite) if isinstance(raw, dict) else None
        if not isinstance(sec, dict) or not isinstance(sec.get("mutants"), dict):
            raise mc.ConfigError(f"config sem a seção {suite}.mutants")
        cfg = mc.load_mutant_config(sec["mutants"])
        missing, orphan = sorted(set(catalog) - set(cfg)), sorted(set(cfg) - set(catalog))
        if missing or orphan:
            raise mc.ConfigError(f"{suite}: mutantes sem config {missing} / config órfã {orphan}")
        changes = sec.get("changes") or {}
        for mid, spec in cfg.items():
            if not (isinstance(changes.get(mid), str) and changes[mid].strip()):
                raise mc.ConfigError(f"{mid}: sem descrição da mudança (changes)")
            for e in spec["primary"]:
                if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                    raise mc.ConfigError(f"{mid}: primária sem assertion_pattern (o marcador da asserção é obrigatório)")
            if titles is not None:
                for e in spec["primary"] + spec["secondary"]:
                    hits = [t for t in titles.get(suite, []) if mc._test_matches(e["test_pattern"], t)]
                    if len(hits) != 1:
                        raise mc.ConfigError(f"{mid}: test_pattern casa com {len(hits)} testes (exige 1): {e['test_pattern'][:60]}")
        out[suite] = cfg
    return out


# ---------------------------------------------------------------- staging and running
def stage(dst, mutation=None):
    """Copies the minimal tree (LF-normalised: Windows checkouts may carry CRLF, anchors are LF) and applies the
    mutation. -> False when the anchor is missing or not unique."""
    for rel in COPY:
        src = REPO / rel
        (dst / rel).parent.mkdir(parents=True, exist_ok=True)
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, dst / rel)
    for f in dst.rglob("*"):
        if f.is_file() and f.suffix in (".mjs", ".js", ".json", ".py", ".yml", ".sql", ".html"):
            b = f.read_bytes()
            if b"\r\n" in b:
                f.write_bytes(b.replace(b"\r\n", b"\n"))
    if mutation:
        rel, old, new = mutation
        f = dst / rel
        text = f.read_bytes().decode("utf-8")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root, suite, db="ci_funnel_v2_ctl"):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "FUNNEL_V2_PG_DB": db}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", SUITES[suite]["test"]],
                          cwd=str(root), timeout=SUITES[suite]["timeout"], env=env)


def run_mutant(suite, name, mutation, spec, db):
    with tempfile.TemporaryDirectory() as tmp:
        ok = stage(Path(tmp), mutation)
        run = run_suite(tmp, suite, db) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(SUITES[suite]["total"], run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def baseline(suite):
    with tempfile.TemporaryDirectory() as tmp:
        stage(Path(tmp))
        run = run_suite(tmp, suite)
    parsed = mc.parse_tap(run.get("stdout", ""), stderr=run.get("stderr", ""))
    vb = mc.validate_baseline(SUITES[suite]["total"], run.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=run.get("timed_out", False), signal=run.get("signal"))
    titles = [p["test_id"] for p in parsed["summary"].get("points") or []]
    return vb, titles, run


# ---------------------------------------------------------------- causality document
def render_doc(raw):
    def cell(s):
        return str(s).replace("|", "\\|").replace("\n", " ")

    lines = ["# Causalidade dos mutantes do Funil v2 (#893)", "",
             "Gerado por `python3 scripts/ci/mutants_funnel_v2.py --write-doc` a partir de `scripts/ci/mutants_funnel_v2_config.json`; "
             "`tests/test_mutants_funnel_v2_classifier.py` falha se este arquivo divergir da config.", "",
             "As expectativas foram escritas por **raciocínio sobre cada mutação** (qual regra ela quebra, qual asserção codifica a regra "
             "e é a primeira a falhar dentro do teste, já que `node:test` para na primeira asserção que falha), antes de rodá-la. "
             "Não foram copiadas de falhas observadas.", "",
             "## Classificador", "",
             "O runner usa o classificador **compartilhado** `scripts/ci/mutant_classifier.py` (#901), sem modificação. A config é validada "
             "por `load_mutant_config` antes de qualquer execução; cada primária nomeia o teste **e** o marcador da asserção "
             "(`[FUnn.k]` na suíte unitária, `[FPn.k]` na PostgreSQL, presente na mensagem da asserção), conferido **dentro** do bloco "
             "`not ok` daquele teste.", "",
             "- **KILLED** só com asserção primária casada e nenhuma falha fora de primária ∪ secundária.",
             "- **INCONCLUSIVE**: outra asserção do mesmo teste primário; falha só em secundária; falha não relacionada; todo/skip/cancelled; "
             "contagem de pontos incoerente com o plano ou o resumo; TAP truncado; queda, sintaxe, timeout ou sinal; âncora não única.",
             "- Validação antes de rodar (exit 2): config inválida, primária sem marcador, mutante sem config ou sem descrição, "
             "`test_pattern` que não casa com exatamente 1 teste da baseline, baseline diferente de 21/4 testes.",
             "- Resumo do Node 24 no reporter spec (`ℹ skipped 0`) e no TAP (`# skipped 0`): lidos pelo parser compartilhado.", "",
             "Contraprovas (`tests/test_mutants_funnel_v2_classifier.py`, Node real): primária falhando em outra asserção, `todo`/`t.todo`, "
             "TAP inconsistente (ponto removido, plano ou resumo adulterado/ausente), falha só em secundária, falha não relacionada e "
             "queda ⇒ INCONCLUSIVE; asserção primária ⇒ KILLED.", ""]
    notes = raw.get("first_strict_run") or []
    if notes:
        lines += ["## Primeira execução estrita", ""] + [f"- {n}" for n in notes] + [""]
    head = ["| mutant | change | primary | justification | counter-proof |", "|---|---|---|---|---|"]
    for suite, title in (("unit", "Suíte unitária (`tests/funnel-counting.test.mjs`, 21 testes)"),
                         ("pg", "Suíte PostgreSQL 16 real (`tests/integration/funnel-own-sales-postgres.test.mjs`, 4 testes)")):
        sec = raw[suite]
        lines += [f"## {title} — {len(sec['mutants'])} mutantes", ""] + head
        for mid, spec in sec["mutants"].items():
            prim = "<br>".join(f"**{cell(e['test_pattern'])}** `{cell(e['assertion_pattern'])}` — {cell(e.get('why', ''))}" for e in spec["primary"])
            secs = spec.get("secondary") or []
            just = "<br>".join(f"secundária **{cell(e['test_pattern'])}** `{cell(e.get('assertion_pattern') or 'qualquer')}`: {cell(e['justification'])}" for e in secs) or "só primária"
            if spec.get("broad_reason"):
                just += f"<br>broad_reason: {cell(spec['broad_reason'])}"
            plabels = ", ".join(f"`{e['assertion_pattern']}`" for e in spec["primary"])
            proof = f"outra asserção do teste primário (≠ {plabels}) ⇒ INCONCLUSIVE; falha fora da lista ⇒ INCONCLUSIVE"
            if secs:
                proof += "; falha só na secundária ⇒ INCONCLUSIVE"
            lines.append(f"| {cell(mid.split(' ')[0])} | {cell(sec['changes'][mid])} | {prim} | {just} | {proof} |")
        lines.append("")
    return "\n".join(lines)


def write_doc():
    raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    load_config()
    p = REPO / DOC_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as h:
        h.write(render_doc(raw))
    print("WROTE", DOC_FILE)
    return 0


# ---------------------------------------------------------------- main
def main(argv):
    global REPO
    args = [a for a in argv if not a.startswith("--")]
    suite_arg = argv[argv.index("--suite") + 1] if "--suite" in argv else "all"
    args = [a for a in args if a != suite_arg]
    REPO = Path(args[0]).resolve() if args else HERE.parents[1]
    if "--write-doc" in argv:
        return write_doc()
    if os.environ.get("FUNNEL_MUTANTS_UNIT_ONLY") == "1":
        suite_arg = "unit"
    if suite_arg not in ("unit", "pg", "all"):
        print("USO: --suite unit|pg|all")
        return mc.EXIT_BAD_BASELINE
    suites = ["unit", "pg"] if suite_arg == "all" else [suite_arg]
    try:
        load_config()  # structural validation before anything runs
    except (mc.ConfigError, ValueError, OSError) as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE
    if "pg" in suites and not os.environ.get("T4_PG_HOST"):
        print("BASELINE FAILED suite=pg T4_PG_HOST ausente (PostgreSQL descartável obrigatório)")
        return mc.EXIT_BAD_BASELINE
    print("NODE_VERSION=" + (mc.run_command([NODE, "--version"]).get("stdout") or "?").strip())
    titles = {}
    for s in suites:
        vb, t, run = baseline(s)
        if not vb["ok"]:
            print((run.get("stdout") or "")[-3000:])
            print(f"BASELINE FAILED suite={s} {vb['reason']}")
            return mc.EXIT_BAD_BASELINE
        titles[s] = t
        print(f"BASELINE PASS suite={s} tests={SUITES[s]['total']}")
    try:
        cfg = load_config(titles=titles, mutants={s: MUTANTS[s] for s in suites})
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    items = [(s, i, name, mut) for s in suites for i, (name, mut) in enumerate(MUTANTS[s].items())]

    def judge(item):
        s, i, name, mutation = item
        db = f"ci_funnel_v2_{s}_m{i}"
        res = run_mutant(s, name, mutation, cfg[s][name], db)
        first = None
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(s, name, mutation, cfg[s][name], db)
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        res["suite"], res["first_attempt_inconclusive"] = s, first
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, items))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        if r["first_attempt_inconclusive"]:
            print(f"RETRY {r['mutant_id']} 1ª tentativa INCONCLUSIVE ({r['first_attempt_inconclusive'][:300]})")
        print("RESULT " + json.dumps({k: r.get(k) for k in ("suite", "mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures", "first_attempt_inconclusive")}, ensure_ascii=False))
    print(f"RETRIES={sum(1 for r in results if r['first_attempt_inconclusive'])}")
    code, summary = mc.aggregate(results, baseline_valid=True)
    for s in suites:
        rs = [r for r in results if r["suite"] == s]
        print(f"MUTANTS_FUNNEL_V2 suite={s} total={len(rs)} killed={sum(r['verdict'] == mc.KILLED for r in rs)} "
              f"survived={sum(r['verdict'] == mc.SURVIVED for r in rs)} inconclusive={sum(r['verdict'] == mc.INCONCLUSIVE for r in rs)}")
    print(f"MUTANTS_FUNNEL_V2 total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} "
          f"inconclusive={summary['INCONCLUSIVE']} exit={code}")
    return code


REPO = HERE.parents[1]

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
