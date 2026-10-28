#!/usr/bin/env python3
"""ZEVANORY | Mutantes do modelo B (Sol ORDEM 313): kits pelo Hotmart Club, trava da rota ZIP e contingência.

Cada mutante desfaz UMA propriedade de segurança no código real e roda os testes que a protegem:
  tests/hotmart-kits.test.mjs                         (sem banco)
  tests/integration/hotmart-kits-postgres.test.mjs    (PostgreSQL real; exige T4_PG_HOST/T4_PG_PORT)
KILLED = o(s) teste(s) esperado(s) aparecem como "not ok" no TAP (falha de asserção daquele teste), nunca só código
de saída != 0. SURVIVED = os esperados passaram. INCONCLUSIVE = arquivo de teste não carregou ou PostgreSQL ausente.
O arquivo mutado é sempre restaurado (git não é usado); no fim confere que nenhum arquivo ficou alterado.

Uso: T4_PG_HOST=/var/tmp/pg-kits/sock T4_PG_PORT=55440 python3 -I scripts/ci/mutants_kits_club_b.py [--only M01,M02]
Saída: uma linha "MUTANT <id> <KILLED|SURVIVED|INCONCLUSIVE> expected=<testes> failed=<testes>" e o resumo
"MUTANTS_TOTAL=N KILLED=K SURVIVED=S INCONCLUSIVE=I". Código 0 só com todos KILLED.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UNIT = "tests/hotmart-kits.test.mjs"
PG = "tests/integration/hotmart-kits-postgres.test.mjs"
REC = "worker/cloudflare-worker.recovered.mjs"
KITS = "worker/hotmart-kits.mjs"

# (id, descrição, arquivo, trecho original, trecho mutado, testes que devem falhar: prefixos "K1", "Z1"...)
MUTANTS = [
    ("M01", "emissão do ZIP sem a lista fechada de provedores", REC,
     "where o.order_id=$1 and o.status='paid' and o.provider in ${OWN_CHECKOUT_PROVIDERS_SQL}", "where o.order_id=$1 and o.status='paid'", ["K1", "Z1"]),
    ("M02", "consumo do link do ZIP sem a lista fechada de provedores", REC,
     "o.order_id=t.order_id and o.status='paid' and o.provider in ${OWN_CHECKOUT_PROVIDERS_SQL}", "o.order_id=t.order_id and o.status='paid'", ["K1", "Z2"]),
    ("M03", "lista de provedores aceita 'hotmart'", REC,
     'var OWN_CHECKOUT_PROVIDERS = Object.freeze(["mercadopago", "asaas"]);', 'var OWN_CHECKOUT_PROVIDERS = Object.freeze(["mercadopago", "asaas", "hotmart"]);', ["K1", "Z1"]),
    # M04 tira as DUAS barreiras de uma vez (filtro no SQL e checagem em JS são defesa em profundidade: tirar só a do SQL
    # é equivalente, a de JS ainda recusa). M05 tira só a de JS (o teste K2 simula o SQL sem filtro).
    ("M04", "/entrega/reenviar sem filtro de provedor (SQL e JS)", "worker/sales-control.mjs",
     ' and o.provider in (\'mercadopago\', \'asaas\') limit 1`, [orderId]);\n  const order = rows[0];',
     " limit 1`, [orderId]);\n  const order = rows[0]; if (order) order.provider = \"mercadopago\";", ["Z3"]),
    ("M05", "/entrega/reenviar sem a checagem de provedor em JS", "worker/sales-control.mjs",
     '!["mercadopago", "asaas"].includes(String(order.provider || "")) || ', "", ["K2"]),
    ("M06", "estado terminal não é pegajoso (aprovação tardia reativa)", KITS,
     "status = case when hotmart_kit_purchases.status in ${REVOKED} then hotmart_kit_purchases.status\n", "status = case when false then hotmart_kit_purchases.status\n", ["P2"]),
    ("M07", "PROTEST revoga a compra", KITS,
     "select $2, $4, case when $5 = 'protest' then 'unknown' else $5 end,", "select $2, $4, case when $5 = 'protest' then 'refunded' else $5 end,", ["P3"]),
    ("M08", "evento duplicado reprocessado (sem registro do evento)", KITS,
     "      on conflict (event_key) do nothing returning 1)", "      on conflict (event_key) do update set received_at = now() returning 1)", ["P1"]),
    ("M09", "download sem exigir compra aprovada", KITS,
     "      and p.transaction_ref = l.transaction_ref and p.status = 'approved' and p.revoked_at is null and p.approved_at is not null\n      and c.id = 1",
     "      and p.transaction_ref = l.transaction_ref and p.approved_at is not null\n      and c.id = 1", ["C5"]),
    ("M10", "download sem exigir contingência ligada", KITS,
     "      and c.id = 1 and c.enabled and c.until > now()\n    returning l.transaction_ref", "      and c.id = 1\n    returning l.transaction_ref", ["C6"]),
    ("M11", "dia 8 com 7 dias (168 h)", "data/hotmart-kits.json",
     '"horas_minimas": 192,\n  "dias_civis": 8', '"horas_minimas": 168,\n  "dias_civis": 7', ["D1", "D2", "C3", "C4"]),
    ("M12", "dia 8 sem a guarda do horário de parede (só horas)", KITS,
     "  return Math.max(byHours, inst);", "  return byHours;", ["D3"]),
    ("M13", "data exibida em UTC em vez de horário de Brasília", KITS,
     "  const w = wall(ms, TZ);\n  const z = (n)", '  const w = wall(ms, "UTC");\n  const z = (n)', ["D2", "R4", "C3", "C4"]),
    ("M14", "download ignora a liberação do dia 8", KITS,
     '  return catalogFor(sku, catalog).filter((f) => f.liberacao === "dia1" || (f.liberacao === "dia8" && open8));',
     "  return catalogFor(sku, catalog);", ["D4", "C4"]),
    ("M15", "destinatário não conferido com o comprador", KITS,
     "  if (!p.buyer_email_ref || p.buyer_email_ref !== emailRef) {", "  if (false) {", ["C2", "C8"]),
    ("M16", "token devolvido ao operador na resposta", KITS,
     "  return json(201, { issued: true, sku: p.sku,", "  return json(201, { issued: true, token, sku: p.sku,", ["C3"]),
    ("M17", "token gravado no registro de auditoria", KITS,
     '(released ? "issued:dia1+dia8" : "issued:dia1")', '(released ? "issued:dia1+dia8" : "issued:dia1:" + token)', ["C3"]),
    ("M18", "reembolso não revoga os links já emitidos", KITS,
     '  if (["refunded", "chargeback", "canceled"].includes(state)) await sql.query(q.revokeLinks, [tref]);\n', "", ["W3", "C5"]),
    ("M19", "falha na gravação do kit não libera a deduplicação", "worker/content-service.mjs",
     "        try { await kv.delete?.(dedupe); } catch {}\n", "", ["W2"]),
    ("M20", "rota de operador sem verificar a credencial", KITS,
     '    if (typeof isOperator !== "function" || !(await isOperator(request))) return json(401, { error: "operator_auth_required" });\n', "", ["R1"]),
    ("M21", "leitura do estado com falha emite link mesmo assim", KITS,
     "  try { p = one(await sql.query(q.purchase, [tref])); } catch {", "  try { p = one(await sql.query(q.purchase, [tref])); } catch { p = { sku: \"ZEV-IA-011\", status: \"approved\", approved_ms: \"1793192400000\", buyer_email_ref: await ref(secret, \"email\", email) }; } if (false) {", ["R2", "C7"]),
    # M22 tira as DUAS barreiras do "desligado por padrão": a leitura do estado e a condição da emissão no SQL.
    ("M22", "contingência ligada por padrão (sem registro de estado)", KITS,
     [('  return s?.open === "true" || s?.open === true || s?.open === "t";', '  return !s || s?.open === "true" || s?.open === true || s?.open === "t";'),
      ("      from hotmart_kit_contingency c where c.id = 1 and c.enabled and c.until > now()\n    returning", "      from (select now() + interval '1 day' as until) c\n    returning")], None, ["C1"]),
    ("M23", "variante Hotmart volta a prometer o link de 72 h", "worker/sales-public-worker.mjs",
     "  [`Entrega: após a confirmação do pagamento, por e-mail, em ${DELIVERY_72H}; se o link expirar, um novo é enviado sem custo pelo suporte.`,EC.resumo_politica],\n", "", ["T4"]),
    ("M24", "privacidade chama a Hotmart de operadora", "privacidade/index.html",
     "Mercado Pago (pagamentos), Resend", "Mercado Pago e Hotmart (pagamentos), Resend", ["T6"]),
]


def tap_failures(text: str) -> set[str]:
    return {m.group(1) for m in re.finditer(r"^not ok \d+ - ([A-Z]\d+[A-Z]?) ", text, re.M)}


def run_tests(pg: bool) -> tuple[str, bool]:
    out, loaded = "", True
    files = [UNIT] + ([PG] if pg else [])
    for f in files:
        r = subprocess.run(["node", "--test", "--test-reporter=tap", f], cwd=ROOT, capture_output=True, text=True, timeout=900, env=os.environ.copy())
        out += r.stdout + r.stderr
        if not re.search(r"^# tests [1-9]", r.stdout, re.M):
            loaded = False
    return out, loaded


def digest(paths: list[str]) -> str:
    h = hashlib.sha256()
    for p in sorted(set(paths)):
        h.update((ROOT / p).read_bytes())
    return h.hexdigest()


_ACTIVE: dict = {}


def _restore(*_):
    # Interrupção (SIGTERM/SIGINT/SIGHUP) no meio de um mutante: devolve o arquivo original antes de sair, para que um
    # mutante nunca fique aplicado na árvore (o finally não roda em sinal não tratado).
    for path, original in list(_ACTIVE.items()):
        Path(path).write_bytes(original)
    _ACTIVE.clear()
    sys.exit(130)


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _restore)
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    pg = bool(os.environ.get("T4_PG_HOST"))
    chosen = [m for m in MUTANTS if not a.only or m[0] in a.only.split(",")]
    files = [m[2] for m in MUTANTS]
    before = digest(files)
    base, loaded = run_tests(pg)
    base_fail = tap_failures(base)
    if base_fail or not loaded:
        print(f"MUTANT BASELINE FAIL failed={sorted(base_fail)} loaded={loaded} pg={pg}")
        return 2
    print(f"MUTANT BASELINE PASS pg={pg}")
    k = s = i = 0
    for mid, desc, path, old, new, expected in chosen:
        p = ROOT / path
        original = p.read_bytes()
        text = original.decode("utf-8")
        pairs = old if isinstance(old, list) else [(old, new)]
        if any(text.count(o) != 1 for o, _ in pairs):
            print(f"MUTANT {mid} INCONCLUSIVE reason=trecho_original_ausente_ou_repetido counts={[text.count(o) for o, _ in pairs]} desc={desc!r}")
            i += 1
            continue
        mutated = text
        for o, n in pairs:
            mutated = mutated.replace(o, n)
        try:
            _ACTIVE[str(p)] = original
            p.write_bytes(mutated.encode("utf-8"))
            out, loaded = run_tests(pg)
        finally:
            p.write_bytes(original)
            _ACTIVE.pop(str(p), None)
        failed = tap_failures(out)
        need_pg = [e for e in expected if e[0] in "ZPC"]
        exp = [e for e in expected if pg or e not in need_pg]
        if not exp or not loaded:
            status = "INCONCLUSIVE"; i += 1
        elif any(e in failed for e in exp):
            status = "KILLED"; k += 1
        else:
            status = "SURVIVED"; s += 1
        print(f"MUTANT {mid} {status} expected={','.join(exp) or '-'} failed={','.join(sorted(failed)) or '-'} desc={desc!r}")
    after = digest(files)
    if before != after:
        print("MUTANT RESTORE FAIL arquivo mutado não foi restaurado")
        return 3
    print(f"MUTANTS_TOTAL={len(chosen)} KILLED={k} SURVIVED={s} INCONCLUSIVE={i}")
    return 0 if k == len(chosen) else 1


if __name__ == "__main__":
    sys.exit(main())
