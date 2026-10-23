#!/usr/bin/env python3
"""Mutantes do Funil v2 (vendas multimeios, lista de espera, intenção real, conversões, Hotmart P0).
Cada mutante altera uma CÓPIA temporária do código (worker/, scripts/audit/, ...) e roda contra ela
tests/funnel-counting.test.mjs e, com T4_PG_HOST definido, tests/integration/funnel-own-sales-postgres.test.mjs.
O original nunca é modificado; só conta como morto o mutante derrubado por uma ASSERÇÃO (erro de sintaxe ou
queda = INCONCLUSIVE). Imprime `MUTANT <id> KILLED|SURVIVED` e sai != 0 se algum sobreviver, se o
controle (sem mutação) falhar ou se um mutante SQL não puder rodar por falta de PostgreSQL.
Uso: python3 scripts/ci/mutants_funnel_v2.py [raiz-do-repo]
"""
import os, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
COPY = ["worker", "scripts/audit", "scripts/channels", "data", "db/migrations", "sales-public/material-gratuito.html",
        "tests/funnel-counting.test.mjs", "tests/integration/funnel-own-sales-postgres.test.mjs"]
FC, SNAP, INV = "scripts/audit/funnel-counting.mjs", "scripts/audit/command-center-snapshot.mjs", "scripts/audit/autonomy-inventory.mjs"
FUN, SPW = "worker/funnel.mjs", "worker/sales-public-worker.mjs"
UNIT, PG = "unit", "pg"

M = {
    "F1 rótulo Hotmart no ledger próprio é contado": (FC, "if (!OWN_PROVIDERS.includes(provider)) { out.ignoredNonOwnProvider += n(b?.confirmed); continue; }", "", UNIT),
    "F2 checkout próprio ausente vira total completo": (FC, 'const complete = ownTotal != null && hs === "ledger";', "const complete = true;", UNIT),
    "F3 Hotmart sem postback tratada como ledger completo": (FC, '(sales && sales.schema === "zevanory-sales/v1" ? "ledger" : "no_events")', '"ledger"', UNIT),
    "F4 clique de lista contado sem instrumentação": (FC, "const wlClick = v2 && clickInstrumented ?", "const wlClick = v2 ?", UNIT),
    "F5 intenção contada em dias fechados": (FC, "value: v2 && open30.length ? ocs : null", "value: v2 ? ocs : null", UNIT),
    "F6 série antiga reclassificada como completa": (FC, 'integrityClass: "LEGACY_MIXED", label: "Série antiga', 'integrityClass: "COMPLETE", label: "Série antiga', UNIT),
    "F7 conversão visitante→venda usa dias fechados": (FC, "open30.reduce((a, d) => a + n(daily[d]?.site_visitors), 0)", "d30.reduce((a, d) => a + n(daily[d]?.site_visitors), 0)", UNIT),
    "F8 leads confirmados somam pendentes": (FC, "value: lc ?? null", "value: funnel?.last7Days?.leads ?? null", UNIT),
    "F9 sonda inconclusiva vira aceitando": (FC, 'return p.offerMarker ? "accepting" : "inconclusive";', 'return "accepting";', UNIT),
    "F10 erro 049 não reconhecido": (FC, 'if (/^\\/error/i.test(String(p.finalPath || "")) || p.errorCode || p.blockedText) return "closed";', 'if (p.blockedText) return "closed";', UNIT),
    "F11 P0 não levantado com oferta aceitando": (FC, 'if (accepting.length) return { ...base, state: "p0_bypass", severity: "P0" };', "", UNIT),
    "F12 vendas fechadas esperam checkout": (FC, 'salesOpen === false ? "closed" : null', 'salesOpen === false ? "checkout" : null', UNIT),
    "F13 intenção contada antes da sessão criada": (SPW, 'const res=await env.CORE.fetch("https://checkout.internal', 'countView(request,env,ctx,slug,"own_checkout_started",{provider:"mercadopago"});const res=await env.CORE.fetch("https://checkout.internal', UNIT),
    "F14 exposição sempre como botão de compra": (SPW, '{cta:toggleOpen?"buy":"waitlist"}', '{cta:"buy"}', UNIT),
    "F15 painel volta a vendas só Hotmart": (FC, "m.sales30 = salesMetric(combineSales({ sales, own, days: s30days })", "m.sales30 = salesMetric(combineSales({ sales, own: null, days: s30days })", UNIT),
    "F16 inventário aceita P0 como prova": (INV, 'const ok = lock.state === "selling" || lock.state === "closed";', 'const ok = lock.state !== "unknown";', UNIT),
    "F17 painel recomenda levar Comprar à Hotmart": (SNAP, "      ...recommend({ funnel, reach, sales, publications, salesCount }),", '      { title: "x", evidence: "x", action: "Levar o botão Comprar ao checkout da Hotmart", confidence: "alta", risk: "baixo", cost: "R$ 0" },\n      ...recommend({ funnel, reach, sales, publications, salesCount }),', UNIT),
    "S1 failover na mesma sessão conta 2": (FUN, "coalesce(o.session_id::text, o.order_id::text) as purchase", "o.order_id::text as purchase", PG),
    "S2 pedidos de certificação contam": (FUN, "where fe.normalized_event = 'payment_confirmed' and coalesce(o.certification_pilot, false) = false\n                   group by", "where fe.normalized_event = 'payment_confirmed'\n                   group by", PG),
    "S3 dia da venda em UTC": (FUN, "at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as day", "at time zone 'UTC', 'YYYY-MM-DD') as day", PG),
    "S4 intenção sem janela de 30 min": (FUN, "${Math.floor(now / INTENT_BUCKET_MS)}", "${now}", PG),
    "S5 visitor-days deduplicados por página": (FUN, "if (await firstTime(sql, day, SITE_PAGE, vhash))", "if (await firstTime(sql, day, page, vhash))", PG),
    "S6 confirmados pela data do cadastro": (FUN, "and confirmed_at >= current_date - interval '6 days')::int as confirmed", "and created_at >= current_date - interval '6 days')::int as confirmed", PG),
}


def stage(dst):
    for rel in COPY:
        src = REPO / rel
        (dst / rel).parent.mkdir(parents=True, exist_ok=True)
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, dst / rel)


def run(root, kind, db):
    env = {**os.environ, "NODE_NO_WARNINGS": "1"}
    files = ["tests/funnel-counting.test.mjs"] if kind == UNIT else ["tests/integration/funnel-own-sales-postgres.test.mjs"]
    if kind == PG:
        env["FUNNEL_V2_PG_DB"] = db
    p = subprocess.run(["node", "--test", *files], cwd=root, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=600)
    out = p.stdout
    skipped = "# skipped 0" not in out
    return p.returncode, skipped, out


def one(item, idx):
    name, (rel, old, new, kind) = item
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        stage(root)
        f = root / rel
        text = f.read_text(encoding="utf-8")
        if text.count(old) != 1:
            return name, "INVALID (âncora não única: %d)" % text.count(old)
        f.write_text(text.replace(old, new, 1), encoding="utf-8")
        rc, skipped, out = run(root, kind, f"ci_funnel_v2_m{idx}")
        if kind == PG and skipped:
            return name, "NOT_RUN (PostgreSQL ausente)"
        if rc == 0:
            return name, "SURVIVED"
        # Causal kill only: a failing ASSERTION; a crash/syntax error proves nothing.
        return name, "KILLED" if "ERR_ASSERTION" in out and "SyntaxError" not in out else "INCONCLUSIVE"


def main():
    with tempfile.TemporaryDirectory() as tmp:
        stage(Path(tmp))
        for kind in (UNIT, PG):
            rc, skipped, out = run(Path(tmp), kind, "ci_funnel_v2_ctl")
            if rc != 0 or (kind == UNIT and skipped):
                print(out[-3000:]); print(f"CONTROL {kind} FAILED"); return 1
            if kind == PG and skipped and os.environ.get("T4_PG_HOST"):
                print("CONTROL pg SKIPPED with T4_PG_HOST set"); return 1
    items = list(M.items())
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(lambda a: one(*a), [(it, i) for i, it in enumerate(items)]))
    bad = 0
    for name, res in results:
        print(f"MUTANT {name} {res}")
        bad += res != "KILLED"
    print(f"MUTANTS_FUNNEL_V2 killed={sum(r == 'KILLED' for _, r in results)}/{len(results)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
