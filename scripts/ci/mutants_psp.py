#!/usr/bin/env python3
"""Mutantes B05/B08: failover MP -> Asaas, boleto, webhook Asaas endurecido e autorização de estorno por intenção.

Cada mutante altera UM arquivo do código de produção NO LUGAR, roda as três suítes e restaura o arquivo (SHA-256
conferido a cada mutante e no fim):
  unit      node --test tests/psp/*.test.mjs                                       (módulos, sem rede)
  checkout  bundle REAL + PostgreSQL efêmero: tests/integration/psp-checkout-postgres.test.mjs
  refund    PostgreSQL efêmero, conexões concorrentes reais: tests/integration/psp-refund-intent-postgres.test.mjs

Classificação (mesma regra do auditor Sol aplicada no #868), falha a falha na saída TAP:
  * KILLED       — pelo menos uma falha de ASSERÇÃO (AssertionError / ERR_ASSERTION) num teste ESPERADO para o mutante,
                   nenhuma assinatura de infraestrutura em nenhuma suíte, contagens completas, e TODA falha sem asserção
                   coberta pela allowlist CAUSAL por mutante (OTHER_ALLOW: mutante, suíte, teste, regex do erro).
  * SURVIVED     — as três suítes passaram com as contagens exatas da linha de base.
  * INCONCLUSIVE — qualquer outra coisa (infra/transporte, timeout, hook, cancelamento, contagem incompleta, rc != 0 sem
                   falha TAP, asserção só fora dos testes esperados, falha sem asserção não prevista). Repetido até
                   RETRIES vezes; persistindo, o job FALHA (nunca conta como KILLED).
Saída: `MUTANT <id> KILLED|SURVIVED|INCONCLUSIVE reason=... unit_fail= checkout_fail= refund_fail= attempt=`
e `MUTANTS_TOTAL=N KILLED=k SURVIVED=s INCONCLUSIVE=i`.

Modos:
  python3 scripts/ci/mutants_psp.py                      # linha de base + todos os mutantes
  python3 scripts/ci/mutants_psp.py --self-check-infra   # sem mutação + ECONNRESET real injetado => INCONCLUSIVE 3/3
  python3 scripts/ci/mutants_psp.py --self-check-other   # mutante real + TypeError injetado fora da allowlist => INCONCLUSIVE 3/3
Requer T4_PG_HOST (sem ele as suítes PostgreSQL pulariam e um mutante "sobreviveria" sem ter sido testado).
"""
import glob, hashlib, os, re, subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FILES = {
    "failover": "worker/psp-failover.mjs",
    "bundle": "worker/cloudflare-worker.recovered.mjs",
    "hook": "worker/asaas-webhook-safety.mjs",
    "boleto": "worker/asaas-boleto.mjs",
    "refund": "worker/asaas-pix-refund-auth.mjs",
}
ORIG = {k: (REPO / v).read_text(encoding="utf-8") for k, v in FILES.items()}
ORIG_SHA = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in ORIG.items()}
RETRIES = 2
TAP = ["--test-reporter=tap", "--test-reporter-destination=stdout"]
UNIT_FILES = sorted(os.path.relpath(p, REPO) for p in glob.glob(str(REPO / "tests/psp/*.test.mjs")))
SUITES = {  # nome -> (comando, contagem exata)
    "unit": (["node", "--test", *TAP, *UNIT_FILES], 57),
    "checkout": (["node", "--import", "./tests/t4_sim/register.mjs", "--test", *TAP, "tests/integration/psp-checkout-postgres.test.mjs"], 16),
    "refund": (["node", "--test", *TAP, "tests/integration/psp-refund-intent-postgres.test.mjs"], 9),
}
SUITE_TIMEOUT = 600

INFRA_RE = re.compile("|".join([
    r"ECONNRESET", r"ECONNREFUSED", r"EPIPE", r"ETIMEDOUT", r"EHOSTUNREACH", r"ENOTFOUND", r"EADDRINUSE",
    r"fetch failed", r"socket hang up", r"other side closed", r"UND_ERR_\w+", r"T4_INJECTED_ECONNRESET",
    r"could not connect to server", r"connection to server (?:at|on) .{0,200}?failed",
    r"server closed the connection unexpectedly", r"the database system is (?:starting up|shutting down)",
    r"Connection refused", r"too many connections", r"testTimeoutFailure", r"hookFailed", r"cancelledByParent",
]), re.I)
ASSERT_RE = re.compile(r"code: '?ERR_ASSERTION'?|name: '?AssertionError'?")


def sub(key, old, new, start_marker=None):
    """Substitui `old` (que precisa ser único no arquivo, ou o primeiro depois de start_marker)."""
    def f(src):
        if start_marker is None:
            assert src.count(old) == 1, (key, old[:60], src.count(old))
            return src.replace(old, new)
        i = src.index(old, src.index(start_marker))
        return src[:i] + new + src[i + len(old):]
    return (key, f)


def chain(key, *fns):
    def f(src):
        for _, g in fns:
            src = g(src)
        return src
    return (key, f)


CONSUME = "export const CONSUME_REFUND_INTENT_SQL"
M = {
    # --- failover ---
    "M01_failover_apos_ambiguo": sub("failover", "      return { status: out.status || 503, body: { ...out.body, provider, fallback_suppressed: true,",
                                     "      continue;\n      return { status: out.status || 503, body: { ...out.body, provider, fallback_suppressed: true,"),
    "M02_orquestrador_ignora_trava": sub("failover", "const open = (await lockOpen()) === true;", "const open = true;"),
    "M03_handler_asaas_ignora_trava": sub("bundle", "const globalEnabled = pspCommercialLockOpen(env);", "const globalEnabled = true;"),
    "M04_selecao_volta_ao_hash": sub("bundle", "  const selected = ordered.map((p) => ready.find((x2) => x2.provider === p)).find(Boolean) || ready[0];",
                                     "  const selected = ready[createHash(\"sha256\").update(String(operationKey || \"zevanory\")).digest()[0] % ready.length];"),
    "M05_disjuntor_nunca_abre": sub("failover", 'else if (before.state === "closed" && failures.length >= threshold) openedAt = t;', "else if (false) openedAt = t;"),
    "M06_meio_aberto_nao_reabre": sub("failover", 'if (before.state === "half_open") openedAt = t;', 'if (before.state === "half_open") openedAt = null;'),
    "M07_sem_chave_idempotencia": sub("failover", "return `zevanory-order-${id}`;", 'return "";'),
    # --- webhook Asaas ---
    "M08_webhook_sem_segredo_de_caminho": sub("hook", 'const pathValid = constantTimeEqual(expectedPath, String(pathSecret || ""));', "const pathValid = true;"),
    "M09_comparacao_nao_constante": sub("failover", "const same = crypto.timingSafeEqual(da, db);", "const same = a === b;"),
    "M10_webhook_confia_no_corpo": sub("bundle", "const payment = await fetchAsaasPayment(webhook.paymentId, process.env.ASAAS_ENV, process.env.ASAAS_API_KEY);",
                                       "const payment = webhookBody.payment;"),
    "M11_dedupe_kv_desligado": sub("hook", "try { return Boolean(await kv.get(ASAAS_WEBHOOK_DEDUPE_PREFIX + id)); } catch { return false; }", "return false;"),
    "M12_asaas_sem_on_conflict": sub("bundle", "        ON CONFLICT DO NOTHING\n        RETURNING order_id,normalized_event,refunded_total",
                                     "        RETURNING order_id,normalized_event,refunded_total", start_marker="async function handler15("),
    # --- boleto ---
    "M13_boleto_timeout_sem_reconciliar": sub("boleto", "const after = await findExisting(fetchImpl, base, headers, ref, expect, timeoutMs);", "const after = { known: false };"),
    "M14_boleto_ambiguo_vira_retentavel": sub("bundle", "if (providerError instanceof BoletoError && providerError.definitive) {", "if (providerError instanceof BoletoError) {"),
    # --- estorno Pix por intenção (Ordem 076-7) ---
    "R01_estorno_ignora_valor": sub("refund", "payment_id = $1::text AND amount_cents = $2::bigint", "payment_id = $1::text AND $2::bigint > 0"),
    "R02_estorno_ignora_pagamento": sub("refund", "WHERE provider = 'asaas' AND payment_id = $1::text AND", "WHERE provider = 'asaas' AND $1::text <> '' AND"),
    "R03_nonce_reutilizavel": chain("refund",
        sub("refund", "    AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()\n  ORDER BY", "    AND revoked_at IS NULL AND expires_at > now()\n  ORDER BY"),
        sub("refund", "AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()\nRETURNING", "AND revoked_at IS NULL AND expires_at > now()\nRETURNING")),
    "R04_intencao_vencida_aceita": chain("refund",
        sub("refund", "    AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()\n  ORDER BY", "    AND used_at IS NULL AND revoked_at IS NULL\n  ORDER BY"),
        sub("refund", "AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()\nRETURNING", "AND used_at IS NULL AND revoked_at IS NULL\nRETURNING")),
    "R05_consumo_nao_atomico": chain("refund",
        sub("refund", "  ORDER BY created_at ASC LIMIT 1\n  FOR UPDATE SKIP LOCKED)", "  ORDER BY created_at ASC LIMIT 1)"),
        sub("refund", "AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()\nRETURNING", "RETURNING")),
    "R06_token_do_asaas_ignorado": sub("refund", '  if (!constantTimeEqual(expected, Array.isArray(token) ? "" : String(token || ""))) return Object.freeze({ status: "REFUSED", refuseReason: "authorization_token_invalid", http: 401 });\n', ""),
    "R07_intencao_sem_pagamento_confirmado": sub("refund", "  AND EXISTS (SELECT 1 FROM financial_events fe WHERE fe.order_id = o.order_id AND fe.provider = 'asaas'\n              AND fe.provider_payment_id = $3::text AND fe.normalized_event = 'payment_confirmed')\n", ""),
}

# Testes que DEVEM falhar por asserção (prefixo do nome TAP, com espaço) — derivados do comportamento quebrado.
EXPECT = {
    "M01_failover_apos_ambiguo": {"unit": ("F05 ", "F06 "), "checkout": ("C2 ", "C3 ", "C4 ")},
    "M02_orquestrador_ignora_trava": {"unit": ("F10 ", "F11 ", "F12 ", "F13 ")},
    "M03_handler_asaas_ignora_trava": {"checkout": ("C5 ",)},
    "M04_selecao_volta_ao_hash": {"checkout": ("C7 ",)},
    "M05_disjuntor_nunca_abre": {"unit": ("F03 ", "F07 ", "F08 ", "F16 ", "F22 "), "checkout": ("C3 ", "C4 ")},
    "M06_meio_aberto_nao_reabre": {"unit": ("F16 ",)},
    "M07_sem_chave_idempotencia": {"unit": ("F20 ",), "checkout": ("C1 ",)},
    "M08_webhook_sem_segredo_de_caminho": {"unit": ("W03 ",), "checkout": ("W1 ",)},
    "M09_comparacao_nao_constante": {"unit": ("F21 ",)},
    "M10_webhook_confia_no_corpo": {"checkout": ("W2 ", "W3 ", "W4 ")},
    "M11_dedupe_kv_desligado": {"unit": ("W08 ",), "checkout": ("W3 ",)},
    "M12_asaas_sem_on_conflict": {"checkout": ("W3 ",)},
    "M13_boleto_timeout_sem_reconciliar": {"unit": ("B07 ",), "checkout": ("B2 ",)},
    "M14_boleto_ambiguo_vira_retentavel": {"checkout": ("B3 ",)},
    "R01_estorno_ignora_valor": {"refund": ("R2 ",)},
    "R02_estorno_ignora_pagamento": {"refund": ("R3 ",)},
    "R03_nonce_reutilizavel": {"refund": ("R4 ", "R7 ")},
    "R04_intencao_vencida_aceita": {"refund": ("R5 ",)},
    "R05_consumo_nao_atomico": {"refund": ("R6 ", "R7 ")},
    "R06_token_do_asaas_ignorado": {"unit": ("U3 ",), "refund": ("R9 ",)},
    "R07_intencao_sem_pagamento_confirmado": {"refund": ("R8 ",)},
}
assert set(M) == set(EXPECT), "cada mutante precisa da lista de testes esperados"

# Allowlist CAUSAL de falhas sem asserção. Cada entrada vale só para (mutante, suíte, prefixo do teste) e só se o bloco
# TAP casar com a regex, justificada pelo MECANISMO da mutação. Vazia de início: qualquer falha sem asserção observada
# precisa ser explicada aqui (nunca afrouxamento genérico).
OTHER_ALLOW = []
for _e in OTHER_ALLOW:
    _e["re"] = re.compile(_e["regex"])

FAIL_BLOCK = re.compile(r"^(?P<ind>[ \t]*)not ok \d+ - (?P<name>.*)\n(?P<body>(?:(?P=ind)[ \t]+.*\n|\n)*?)(?P=ind)  \.\.\.$", re.M)


def counts(out):
    def g(k):
        m = re.search(rf"^# {k} (\d+)$", out, re.M)
        return int(m.group(1)) if m else -1
    return {k: g(k) for k in ("tests", "pass", "fail", "skipped", "cancelled")}


def analyse(rc, out, err):
    c = counts(out)
    c.update(rc=rc, assertion=[], infra=[], other=[], other_blocks=[], infra_noise=[],
             markers=sorted(set(re.findall(r"T4_INJECTED_[A-Z]+", out))))
    for m in FAIL_BLOCK.finditer(out):
        name, body = m.group("name").strip(), m.group("body")
        if m.group("ind"):
            continue
        if INFRA_RE.search(body):
            c["infra"].append(name)
        elif ASSERT_RE.search(body):
            c["assertion"].append(name)
        else:
            c["other"].append(name)
            c["other_blocks"].append((name, body))
    c["infra_noise"] = sorted({x.group(0) for x in INFRA_RE.finditer(out + "\n" + err)})
    return c


def run_suite(name, env_extra=None):
    cmd, _ = SUITES[name]
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **(env_extra or {})}
    try:
        p = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=SUITE_TIMEOUT, env=env)
        return analyse(p.returncode, p.stdout, p.stderr)
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        c = analyse(-9, out, "")
        c["infra_noise"].append(f"suite_timeout_{SUITE_TIMEOUT}s")
        return c


def run_all(env_by_suite=None):
    return {n: run_suite(n, (env_by_suite or {}).get(n)) for n in SUITES}


def err_sig(body):
    nm = re.search(r"^\s*name: '?([\w.]+)'?", body, re.M)
    er = re.search(r"^\s*error: (?:\|-\n\s*)?(.*)$", body, re.M)
    return re.sub(r"[\s;|]+", "_", f"{nm.group(1) if nm else '?'}:{(er.group(1) if er else '?')[:60]}")


def classify(mid, r):
    infra = {n: c["infra"] + c["infra_noise"] for n, c in r.items() if c["infra"] or c["infra_noise"]}
    if infra:
        return "INCONCLUSIVE", "infra:" + ";".join(f"{n}={'/'.join(sorted(set(v)))[:120]}" for n, v in infra.items())
    for n, c in r.items():
        exact = SUITES[n][1]
        if c["skipped"] != 0 or c["cancelled"] != 0 or c["tests"] != exact or c["pass"] + c["fail"] != exact:
            return "INCONCLUSIVE", f"contagem_incompleta:{n}:tests={c['tests']},pass={c['pass']},fail={c['fail']},skipped={c['skipped']},cancelled={c['cancelled']},rc={c['rc']}"
        if c["rc"] != 0 and not c["assertion"] and not c["other"]:
            return "INCONCLUSIVE", f"rc_{c['rc']}_sem_falha_tap:{n}"
        if c["rc"] == 0 and c["assertion"]:
            return "INCONCLUSIVE", f"assercao_com_rc0:{n}"
    used, unexpected = [], []
    for n, c in r.items():
        for name, body in c["other_blocks"]:
            e = next((e for e in OTHER_ALLOW if e["mutant"] == mid and e["suite"] == n and name.startswith(e["test"]) and e["re"].search(body)), None)
            if e:
                used.append(e["id"])
            else:
                unexpected.append(f"{n}:{name.split(' ')[0]}:{err_sig(body)}")
    if unexpected:
        return "INCONCLUSIVE", "falha_nao_prevista:" + ";".join(unexpected)[:240]
    if not any(c["assertion"] or c["other"] for c in r.values()):
        return "SURVIVED", "todas_as_suites_passaram"
    if not any(c["assertion"] for c in r.values()):
        return "INCONCLUSIVE", "falha_sem_assercao"
    hits = [f"{n}:{t.split(' ')[0]}" for n, pref in EXPECT.get(mid, {}).items() for t in r[n]["assertion"] if t.startswith(pref)]
    if not hits:
        got = ";".join(f"{n}:{','.join(t.split(' ')[0] for t in c['assertion'])}" for n, c in r.items() if c["assertion"])
        return "INCONCLUSIVE", f"assercao_fora_dos_testes_esperados:{got}"
    return "KILLED", "assercao:" + ",".join(hits)[:200] + f" allowlist={','.join(sorted(set(used))) or 'none'}"


def restore():
    for k, rel in FILES.items():
        (REPO / rel).write_text(ORIG[k], encoding="utf-8")
        assert hashlib.sha256((REPO / rel).read_text(encoding="utf-8").encode()).hexdigest() == ORIG_SHA[k], f"restauração falhou: {rel}"


def evaluate(mid, key, source, env_by_suite=None):
    history = []
    for attempt in range(1, RETRIES + 2):
        if key:
            (REPO / FILES[key]).write_text(source, encoding="utf-8")
        try:
            r = run_all(env_by_suite)
        finally:
            restore()
        cls, reason = classify(mid, r)
        fails = " ".join(f"{n}_fail={c['fail']}" for n, c in r.items())
        print(f"MUTANT {mid} {cls} reason={reason} {fails} attempt={attempt}", flush=True)
        history.append((cls, reason, r))
        if cls != "INCONCLUSIVE":
            break
    return history[-1][0], history


def baseline():
    base, ok_all = run_all(), True
    for name, (_, exact) in SUITES.items():
        c = base[name]
        noise = c["infra"] + c["infra_noise"]
        ok = (c["rc"] == 0 and c["fail"] == 0 and c["skipped"] == 0 and c["cancelled"] == 0 and c["tests"] == exact
              and c["pass"] == exact and not noise and not c["assertion"] and not c["other"])
        print(f"MUTANT BASELINE {name} tests={c['tests']} pass={c['pass']} fail={c['fail']} skipped={c['skipped']} "
              f"infra={'/'.join(sorted(set(noise))) or 'none'} {'PASS' if ok else 'FAIL'}", flush=True)
        ok_all &= ok
    return ok_all


def main():
    if not os.environ.get("T4_PG_HOST"):
        print("MUTANT ERROR T4_PG_HOST ausente: as suítes PostgreSQL pulariam")
        return 2
    args = sys.argv[1:]
    if "--self-check-infra" in args:
        final, hist = evaluate("M00_sem_mutacao_econnreset_injetado", None, None, env_by_suite={"checkout": {"T4_INJECT_ECONNRESET": "1"}})
        injected = all("T4_INJECTED_ECONNRESET" in h[2]["checkout"]["infra_noise"] for h in hist)
        ok = final == "INCONCLUSIVE" and injected and len(hist) == RETRIES + 1 and all(h[0] == "INCONCLUSIVE" for h in hist)
        print(f"SELF_CHECK_INFRA attempts={len(hist)} classes={','.join(h[0] for h in hist)} injected={injected} {'PASS' if ok else 'FAIL'}", flush=True)
        return 0 if ok else 1
    if "--self-check-other" in args:
        # Mutante REAL (asserção esperada presente em C7) + TypeError injetado em W5 (fora da allowlist) => INCONCLUSIVE.
        mid = "M04_selecao_volta_ao_hash"
        key, fn = M[mid]
        final, hist = evaluate(mid, key, fn(ORIG[key]), env_by_suite={"checkout": {"T4_INJECT_TYPEERROR": "W5 "}})
        injected = all("T4_INJECTED_TYPEERROR" in h[2]["checkout"]["markers"] for h in hist)
        expected_present = all(any(t.startswith("C7 ") for t in h[2]["checkout"]["assertion"]) for h in hist)
        ok = (final == "INCONCLUSIVE" and injected and expected_present and len(hist) == RETRIES + 1
              and all(h[1].startswith("falha_nao_prevista:checkout:W5:TypeError") for h in hist))
        print(f"SELF_CHECK_OTHER mutant={mid} attempts={len(hist)} classes={','.join(h[0] for h in hist)} injected={injected} "
              f"expected_assertion_present={expected_present} {'PASS' if ok else 'FAIL'}", flush=True)
        return 0 if ok else 1
    if not baseline():
        print("MUTANT ERROR linha de base falhou (contagem, falha ou assinatura de infraestrutura)")
        return 2
    totals = {"KILLED": 0, "SURVIVED": 0, "INCONCLUSIVE": 0}
    only = [a for a in args if not a.startswith("--")]
    try:
        for mid, (key, fn) in M.items():
            if only and mid not in only:
                continue
            mutated = fn(ORIG[key])
            assert mutated != ORIG[key], mid
            final, _ = evaluate(mid, key, mutated)
            totals[final] += 1
    finally:
        restore()
    n = sum(totals.values())
    print(f"MUTANTS_TOTAL={n} KILLED={totals['KILLED']} SURVIVED={totals['SURVIVED']} INCONCLUSIVE={totals['INCONCLUSIVE']} RETRIES={RETRIES}", flush=True)
    return 0 if totals["KILLED"] == n else 1


if __name__ == "__main__":
    sys.exit(main())
