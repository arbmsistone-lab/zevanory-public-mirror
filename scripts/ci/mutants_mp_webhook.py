#!/usr/bin/env python3
"""Mutantes B05 (PR #868): assinatura e idempotência do webhook Mercado Pago.

Cada mutante altera worker/cloudflare-worker.recovered.mjs NO LUGAR, roda as três suítes (unitária da assinatura,
dedupe com conexões PostgreSQL simultâneas e handler HTTP real contra PostgreSQL) e restaura o arquivo original
(verificado por SHA-256 a cada mutante e no fim). Imprime `MUTANT <id> KILLED|SURVIVED` e sai != 0 se algum
sobreviver, se a linha de base não passar com as contagens exatas ou se alguma suíte pular testes
(sem T4_PG_HOST as suítes PG pulam e um mutante "sobreviveria" sem ter sido testado).
Uso: T4_PG_HOST=... T4_PG_PORT=... python3 scripts/ci/mutants_mp_webhook.py
"""
import hashlib, os, re, subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
W = REPO / "worker/cloudflare-worker.recovered.mjs"
ORIG = W.read_text(encoding="utf-8")
ORIG_SHA = hashlib.sha256(ORIG.encode()).hexdigest()
H = ORIG.index("async function handleMercadoPagoWebhook(")

SUITES = {  # nome -> (comando, contagem exata na linha de base)
    "unit": (["node", "--test", "tests/mercadopago-webhook-signature.test.mjs"], None),
    "dedupe_pg": (["node", "--test", "tests/integration/mercadopago-payment-dedupe-postgres.test.mjs"], 4),
    "http_pg": (["node", "--import", "./tests/t4_sim/register.mjs", "--test",
                 "tests/integration/mercadopago-webhook-postgres.test.mjs"], 25),
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
}


def counts(out):
    g = lambda k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)$", out, re.M)) else -1
    return {k: g(k) for k in ("tests", "pass", "fail", "skipped", "cancelled")}


def run_all():
    res = {}
    for name, (cmd, _) in SUITES.items():
        p = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=600)
        res[name] = counts(p.stdout)
        res[name]["rc"] = p.returncode
    return res


def restore():
    W.write_text(ORIG, encoding="utf-8")
    assert hashlib.sha256(W.read_text(encoding="utf-8").encode()).hexdigest() == ORIG_SHA, "restauração falhou"


if not os.environ.get("T4_PG_HOST"):
    print("MUTANT ERROR T4_PG_HOST ausente: as suítes PostgreSQL pulariam")
    sys.exit(2)

base = run_all()
for name, (_, exact) in SUITES.items():
    c = base[name]
    ok = c["rc"] == 0 and c["fail"] == 0 and c["skipped"] == 0 and c["tests"] > 0 and c["tests"] == c["pass"]
    if exact is not None:
        ok &= c["tests"] == exact
    print(f"MUTANT BASELINE {name} tests={c['tests']} pass={c['pass']} fail={c['fail']} skipped={c['skipped']} {'PASS' if ok else 'FAIL'}")
    if not ok:
        sys.exit(2)

survivors = 0
try:
    for mid, fn in M.items():
        mutated = fn(ORIG)
        assert mutated != ORIG, mid
        W.write_text(mutated, encoding="utf-8")
        try:
            r = run_all()
        finally:
            restore()
        if any(c["skipped"] not in (0, -1) for c in r.values()):
            print(f"MUTANT {mid} ERROR testes pulados")
            sys.exit(2)
        # Morto = alguma suíte falhou (falha de asserção ou código de saída != 0).
        killed = any(c["fail"] > 0 or c["rc"] != 0 for c in r.values())
        survivors += 0 if killed else 1
        detail = " ".join(f"{n}_fail={c['fail']}" for n, c in r.items())
        print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} {detail}", flush=True)
finally:
    restore()
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
