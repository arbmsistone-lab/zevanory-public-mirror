#!/usr/bin/env python3
"""Mutantes B05 (PR #868): assinatura e idempotência do webhook Mercado Pago.

Cada mutante altera worker/cloudflare-worker.recovered.mjs NO LUGAR, roda as três suítes (unitária da assinatura,
dedupe com conexões PostgreSQL simultâneas e handler HTTP real contra PostgreSQL) e restaura o arquivo original
(verificado por SHA-256 a cada mutante e no fim).

Classificação (exigência do auditor Sol): a saída TAP de cada suíte é analisada falha a falha.
  * KILLED       — pelo menos uma falha de ASSERÇÃO (AssertionError / ERR_ASSERTION) em um teste esperado para
                   aquele mutante, nenhuma assinatura de infraestrutura em nenhuma suíte e contagens completas.
  * SURVIVED     — as três suítes passaram com as contagens exatas da linha de base (nenhuma falha).
  * INCONCLUSIVE — qualquer outra coisa: erro de transporte/infra (ECONNRESET, fetch failed, ECONNREFUSED, EPIPE,
                   conexão psql recusada, timeout, hook falho, cancelamento) em QUALQUER suíte, só falhas sem
                   asserção, código de saída != 0 sem falha TAP, contagem incompleta, ou asserção apenas fora dos
                   testes esperados. (Falhas funcionais sem asserção — p.ex. TypeError do handler mutado ou violação
                   de chave única do PostgreSQL — são relatadas, mas sozinhas não matam o mutante.)
                   É repetido até RETRIES vezes; se continuar INCONCLUSIVE o job FALHA (nunca conta como KILLED).
A linha de base (código sem mutação) precisa passar com as contagens exatas e SEM assinatura de infra.
Saída por mutante: `MUTANT <id> KILLED|SURVIVED|INCONCLUSIVE reason=... unit_fail= dedupe_pg_fail= http_pg_fail=`
(também como anotação ::notice:: quando GITHUB_ACTIONS=true).

Modos:
  python3 scripts/ci/mutants_mp_webhook.py                 # linha de base + 13 mutantes
  python3 scripts/ci/mutants_mp_webhook.py --self-check-infra
      Meta-teste: NENHUMA mutação; o harness HTTP injeta um ECONNRESET real (T4_INJECT_ECONNRESET=1).
      Passa (rc 0) somente se a classificação for INCONCLUSIVE em todas as tentativas (nunca KILLED) e a
      injeção tiver de fato ocorrido.
Requer T4_PG_HOST (sem ele as suítes PG pulariam e um mutante "sobreviveria" sem ter sido testado).
"""
import hashlib, os, re, subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
W = REPO / "worker/cloudflare-worker.recovered.mjs"
ORIG = W.read_text(encoding="utf-8")
ORIG_SHA = hashlib.sha256(ORIG.encode()).hexdigest()
H = ORIG.index("async function handleMercadoPagoWebhook(")
RETRIES = 2  # repetições controladas após um INCONCLUSIVE (total de tentativas = 1 + RETRIES)
GHA = os.environ.get("GITHUB_ACTIONS") == "true"

TAP = ["--test-reporter=tap", "--test-reporter-destination=stdout"]
SUITES = {  # nome -> (comando, contagem exata na linha de base)
    "unit": (["node", "--test", *TAP, "tests/mercadopago-webhook-signature.test.mjs"], 11),
    "dedupe_pg": (["node", "--test", *TAP, "tests/integration/mercadopago-payment-dedupe-postgres.test.mjs"], 4),
    "http_pg": (["node", "--import", "./tests/t4_sim/register.mjs", "--test", *TAP,
                 "tests/integration/mercadopago-webhook-postgres.test.mjs"], 25),
}
SUITE_TIMEOUT = 600

# Assinaturas de infraestrutura/transporte. Procuradas no bloco de cada falha E na saída inteira da suíte
# (stdout+stderr): basta uma ocorrência para a execução não poder contar como KILLED.
INFRA_RE = re.compile("|".join([
    r"ECONNRESET", r"ECONNREFUSED", r"EPIPE", r"ETIMEDOUT", r"EHOSTUNREACH", r"ENOTFOUND",
    r"fetch failed", r"socket hang up", r"other side closed", r"UND_ERR_\w+", r"T4_TRANSPORT_ERROR",
    r"T4_INJECTED_ECONNRESET",
    r"could not connect to server", r"connection to server (?:at|on) .{0,200}?failed",
    r"server closed the connection unexpectedly", r"the database system is (?:starting up|shutting down)",
    r"Connection refused", r"too many connections",
    r"timed out", r"testTimeoutFailure", r"hookFailed", r"cancelledByParent",
]), re.I)
ASSERT_RE = re.compile(r"code: '?ERR_ASSERTION'?|name: '?AssertionError'?")

# Testes que DEVEM falhar por asserção para o mutante contar como morto (prefixo do nome do teste TAP).
# Derivados do comportamento que cada mutante quebra; a lista é "pelo menos um destes".
SIG_HTTP_401 = ("M20 ",)  # casos 401 do handler real (inclui o discriminativo de M4a)
EXPECT = {
    "M1_pula_comparacao_hmac": {"unit": ("S2 ", "S3 ", "S11 "), "http_pg": ("M1 ", "M20 ")},
    "M2_janela_60min": {"unit": ("S4 ",), "http_pg": ("M20 ",)},
    "M3_aceita_ts_futuro": {"unit": ("S4 ",), "http_pg": ("M20 ",)},
    "M4a_nao_exige_request_id": {"unit": ("S5 ",), "http_pg": SIG_HTTP_401},
    "M4b_manifesto_ignora_request_id": {"unit": ("S1 ", "S3 ", "S6 ", "S11 "), "http_pg": ("M3+M8 ", "M19 ", "M20 ")},
    "M5_aceita_ts_ausente": {"unit": ("S5 ",), "http_pg": SIG_HTTP_401},
    "M6a_chave_evento_aleatoria": {"dedupe_pg": ("D1 ",), "http_pg": ("M3+M8 ", "M3 ", "M22 ", "M11a ")},
    "M6b_sem_on_conflict": {"dedupe_pg": ("D1 ", "D2 ", "D3 "), "http_pg": ("M3+M8 ", "M3 ", "M22 ")},
    "M6c_chave_entrega_aleatoria": {"http_pg": ("M3+M8 ", "M3 ", "M13 ", "M16 ", "M22 ")},
    "M7_processa_assinatura_invalida": {"http_pg": ("M1 ", "M20 ", "M6 ", "M11c ")},
    "M8_nao_enfileira_recuperacao": {"http_pg": ("M1 ", "M20 ", "M6 ", "M11c ")},
    "M9_comparacao_nao_constante": {"unit": ("S11 ",)},
    "M10_dedupe_vira_upsert": {"dedupe_pg": ("D1 ", "D2 ", "D3 "), "http_pg": ("M3+M8 ", "M3 ", "M22 ", "M11a ")},
}


def sub_global(old, new):
    def f(s):
        assert s.count(old) == 1, (old, s.count(old))
        return s.replace(old, new)
    return f


def sub_after(old, new, start):
    def f(s):
        i = s.index(old, start)
        return s[:i] + new + s[i + len(old):]
    return f


M = {
    "M1_pula_comparacao_hmac": sub_global("return a2.length === b2.length && crypto5.timingSafeEqual(a2, b2);", "return true;"),
    "M2_janela_60min": sub_global("Math.abs(now - tsMs) > 10 * 60 * 1e3", "Math.abs(now - tsMs) > 60 * 60 * 1e3"),
    "M3_aceita_ts_futuro": sub_global("Math.abs(now - tsMs) > 10 * 60 * 1e3", "(now - tsMs) > 10 * 60 * 1e3"),
    "M4a_nao_exige_request_id": sub_global("!/^[a-f0-9]{64}$/i.test(v1) || !safeText2(requestId, 1, 160) ||", "!/^[a-f0-9]{64}$/i.test(v1) ||"),
    "M4b_manifesto_ignora_request_id": sub_global("const manifest = `id:${dataId};request-id:${requestId};ts:${ts2};`;", "const manifest = `id:${dataId};ts:${ts2};`;"),
    "M5_aceita_ts_ausente": lambda s: sub_global(
        "if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > 10 * 60 * 1e3) return false;",
        "if (ts2 && (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > 10 * 60 * 1e3)) return false;")(
        sub_global("if (!/^\\d{10,13}$/.test(ts2) || !/^[a-f0-9]{64}$/i", "if (!/^[a-f0-9]{64}$/i")(s)),
    "M6a_chave_evento_aleatoria": sub_global(
        "const providerEventId = `${prefix}:${webhook.paymentId}:${String(payment.status || \"\")}:${String(payment.transaction_amount_refunded || 0)}`;",
        "const providerEventId = `${prefix}:${webhook.paymentId}:${String(payment.status || \"\")}:${String(payment.transaction_amount_refunded || 0)}:${crypto5.randomUUID()}`;"),
    "M6b_sem_on_conflict": sub_after("        ON CONFLICT DO NOTHING\n        RETURNING order_id,normalized_event,refunded_total",
                                     "        RETURNING order_id,normalized_event,refunded_total", H),
    "M6c_chave_entrega_aleatoria": sub_global(
        "const deliveryKey = `zevanory-delivery-${String(payment?.id || \"\")}-${createHash(\"sha256\").update(String(evidence.download_url || \"\")).digest(\"hex\").slice(0, 16)}`;",
        "const deliveryKey = `zevanory-delivery-${String(payment?.id || \"\")}-${crypto5.randomUUID()}`;"),
    "M7_processa_assinatura_invalida": sub_global('  if (!signatureValid) return json12(res, 401, { error: "webhook_auth_failed", accepted: false });\n', ""),
    "M8_nao_enfileira_recuperacao": sub_global("if (!trustedRecovery) await recordMercadoPagoWebhookSignature(", "if (false) await recordMercadoPagoWebhookSignature("),
    "M9_comparacao_nao_constante": sub_global("return a2.length === b2.length && crypto5.timingSafeEqual(a2, b2);", "return expected === v1.toLowerCase();"),
    # Mutante independente (pedido do auditor; autor distinto dos 12 acima): a deduplicação vira "upsert" — a chave
    # única continua lá, mas a duplicata ATUALIZA a linha e o RETURNING devolve a linha também para a duplicata,
    # então a transição para pago e a entrega rodam de novo em cada reentrega/concorrente (difere de M6b, que remove
    # o ON CONFLICT e faz a duplicata falhar com violação de chave).
    "M10_dedupe_vira_upsert": sub_after("        ON CONFLICT DO NOTHING\n        RETURNING order_id,normalized_event,refunded_total",
                                        "        ON CONFLICT (provider_event_id) DO UPDATE SET provider_status=EXCLUDED.provider_status\n        RETURNING order_id,normalized_event,refunded_total", H),
}
assert set(M) == set(EXPECT), "cada mutante precisa da lista de testes esperados"

FAIL_BLOCK = re.compile(r"^(?P<ind>[ \t]*)not ok \d+ - (?P<name>.*)\n(?P<body>(?:(?P=ind)[ \t]+.*\n|\n)*?)(?P=ind)  \.\.\.$", re.M)


def counts(out):
    def g(k):
        m = re.search(rf"^# {k} (\d+)$", out, re.M)
        return int(m.group(1)) if m else -1
    return {k: g(k) for k in ("tests", "pass", "fail", "skipped", "cancelled")}


def analyse(name, rc, out, err):
    """Uma suíte -> dicionário com contagens, falhas de asserção, falhas de infra e outras."""
    c = counts(out)
    c.update(rc=rc, assertion=[], infra=[], other=[], infra_noise=[])
    for m in FAIL_BLOCK.finditer(out):
        test_name, body = m.group("name").strip(), m.group("body")
        if m.group("ind"):  # subteste aninhado: a falha relevante é a do teste de topo
            continue
        if INFRA_RE.search(body):
            c["infra"].append(test_name)
        elif ASSERT_RE.search(body):
            c["assertion"].append(test_name)
        else:
            c["other"].append(test_name)
    for sig in sorted({x.group(0) for x in INFRA_RE.finditer(out + "\n" + err)}):
        c["infra_noise"].append(sig)
    return c


def run_suite(name, env_extra=None):
    cmd, _ = SUITES[name]
    env = {**os.environ, **(env_extra or {})}
    try:
        p = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                           timeout=SUITE_TIMEOUT, env=env)
        return analyse(name, p.returncode, p.stdout, p.stderr)
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        c = analyse(name, -9, out, "")
        c["infra_noise"].append(f"suite_timeout_{SUITE_TIMEOUT}s")
        return c


def run_all(env_by_suite=None):
    return {n: run_suite(n, (env_by_suite or {}).get(n)) for n in SUITES}


def classify(mid, r):
    """-> (classe, motivo)."""
    infra = {n: c["infra"] + c["infra_noise"] for n, c in r.items() if c["infra"] or c["infra_noise"]}
    if infra:
        return "INCONCLUSIVE", "infra:" + ";".join(f"{n}={'/'.join(sorted(set(v)))[:120]}" for n, v in infra.items())
    for n, c in r.items():
        exact = SUITES[n][1]
        if c["skipped"] not in (0,) or c["cancelled"] not in (0,) or c["tests"] != exact or c["pass"] + c["fail"] != exact:
            return "INCONCLUSIVE", f"contagem_incompleta:{n}:tests={c['tests']},pass={c['pass']},fail={c['fail']},skipped={c['skipped']},cancelled={c['cancelled']},rc={c['rc']}"
        if c["rc"] != 0 and not c["assertion"] and not c["other"]:
            return "INCONCLUSIVE", f"rc_{c['rc']}_sem_falha_tap:{n}"
        if c["rc"] == 0 and c["assertion"]:
            return "INCONCLUSIVE", f"assercao_com_rc0:{n}"
    if not any(c["assertion"] or c["other"] for c in r.values()):
        return "SURVIVED", "todas_as_suites_passaram"
    if not any(c["assertion"] for c in r.values()):
        got = ";".join(f"{n}:{','.join(t.split(' ')[0] for t in c['other'])}" for n, c in r.items() if c["other"])
        return "INCONCLUSIVE", f"falha_sem_assercao:{got}"
    expected = EXPECT.get(mid, {})
    hits = [f"{n}:{t.split(' ')[0]}" for n, pref in expected.items() for t in r[n]["assertion"] if t.startswith(pref)]
    if not hits:
        got = ";".join(f"{n}:{','.join(t.split(' ')[0] for t in c['assertion'])}" for n, c in r.items() if c["assertion"])
        return "INCONCLUSIVE", f"assercao_fora_dos_testes_esperados:{got}"
    others = sum(len(c["other"]) for c in r.values())
    return "KILLED", "assercao:" + ",".join(hits)[:200] + (f";outras_falhas_funcionais={others}" if others else "")


def report(mid, cls, reason, r, attempt):
    fails = " ".join(f"{n}_fail={c['fail']}" for n, c in r.items())
    line = f"MUTANT {mid} {cls} reason={reason} {fails} attempt={attempt}"
    print(line, flush=True)
    if GHA:
        print(f"::notice title=MUTANT {mid}::{line}", flush=True)


def restore():
    W.write_text(ORIG, encoding="utf-8")
    assert hashlib.sha256(W.read_text(encoding="utf-8").encode()).hexdigest() == ORIG_SHA, "restauração falhou"


def evaluate(mid, source, env_by_suite=None):
    """Roda com repetição controlada: INCONCLUSIVE -> até RETRIES novas tentativas. -> (classe final, histórico)."""
    history = []
    for attempt in range(1, RETRIES + 2):
        W.write_text(source, encoding="utf-8")
        try:
            r = run_all(env_by_suite)
        finally:
            restore()
        cls, reason = classify(mid, r)
        report(mid, cls, reason, r, attempt)
        history.append((cls, reason, r))
        if cls != "INCONCLUSIVE":
            break
    return history[-1][0], history


def baseline():
    base = run_all()
    ok_all = True
    for name, (_, exact) in SUITES.items():
        c = base[name]
        noise = c["infra"] + c["infra_noise"]
        ok = (c["rc"] == 0 and c["fail"] == 0 and c["skipped"] == 0 and c["cancelled"] == 0 and c["tests"] == exact
              and c["pass"] == exact and not noise and not c["assertion"] and not c["other"])
        line = (f"MUTANT BASELINE {name} tests={c['tests']} pass={c['pass']} fail={c['fail']} skipped={c['skipped']} "
                f"infra={'/'.join(sorted(set(noise))) or 'none'} {'PASS' if ok else 'FAIL'}")
        print(line, flush=True)
        if GHA:
            print(f"::notice title=MUTANT BASELINE {name}::{line}", flush=True)
        ok_all &= ok
    return ok_all


def main():
    if not os.environ.get("T4_PG_HOST"):
        print("MUTANT ERROR T4_PG_HOST ausente: as suítes PostgreSQL pulariam")
        return 2
    self_check = "--self-check-infra" in sys.argv[1:]
    if self_check:
        # Meta-teste: código ORIGINAL (sem mutação) + ECONNRESET real injetado pelo harness na 1ª requisição POST.
        final, hist = evaluate("M0_sem_mutacao_econnreset_injetado", ORIG,
                               env_by_suite={"http_pg": {"T4_INJECT_ECONNRESET": "1"}})
        injected = all("T4_INJECTED_ECONNRESET" in h[2]["http_pg"]["infra_noise"] for h in hist)
        never_killed = all(h[0] == "INCONCLUSIVE" for h in hist)
        ok = final == "INCONCLUSIVE" and never_killed and injected and len(hist) == RETRIES + 1
        print(f"SELF_CHECK_INFRA attempts={len(hist)} classes={','.join(h[0] for h in hist)} injected={injected} "
              f"{'PASS' if ok else 'FAIL'}", flush=True)
        return 0 if ok else 1

    if not baseline():
        print("MUTANT ERROR linha de base falhou (contagem, falha ou assinatura de infraestrutura)")
        return 2
    totals = {"KILLED": 0, "SURVIVED": 0, "INCONCLUSIVE": 0}
    try:
        for mid, fn in M.items():
            mutated = fn(ORIG)
            assert mutated != ORIG, mid
            final, _ = evaluate(mid, mutated)
            totals[final] += 1
    finally:
        restore()
    print(f"MUTANTS_TOTAL={len(M)} KILLED={totals['KILLED']} SURVIVED={totals['SURVIVED']} "
          f"INCONCLUSIVE={totals['INCONCLUSIVE']} RETRIES={RETRIES}", flush=True)
    return 0 if totals["KILLED"] == len(M) else 1


if __name__ == "__main__":
    sys.exit(main())
