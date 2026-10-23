#!/usr/bin/env python3
"""ZEVANORY | Gate "dois PSPs prontos" (B05/B08), no molde de scripts/provider_independence_gate.py.

Diferença deliberada: 100% OFFLINE. Não chama provedor de pagamento, não sonda produção, não usa segredo
(valores sintéticos só em memória). Prova, com o código do PR:
  1. contrato de evidência (evidence/psp-independence.json);
  2. prontidão REAL do bundle (paymentProviderCandidates/selectPaymentProvider): com configuração completa dos dois,
     quórum 2 e ordem fixa mercadopago -> asaas; sem o segredo de caminho do webhook Asaas, o Asaas NÃO fica pronto;
  3. plano de continuidade: redundant / degraded / fail_closed / sales_locked;
  4. trava comercial fechada: o orquestrador não chama NENHUM provedor; dois fora => 503 fail-closed;
     resultado ambíguo => nunca chama o segundo provedor;
  5. nenhum segredo de provedor no código-fonte.
Saída: linhas "PSP_GATE <check> PASS|FAIL" e "PSP_TWO_PROVIDERS_GATE: PASS" (rc 0) ou rc 2.
"""
from __future__ import annotations
import json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence" / "psp-independence.json"
SECRET_PATTERNS = [
    re.compile(r"\$aact_(?:prod|hmlg)_[A-Za-z0-9]{8,}"),        # chave de API Asaas
    re.compile(r"APP_USR-\d{6,}-\d{6}-[a-f0-9]{16,}"),            # access token Mercado Pago de produção
    re.compile(r"TEST-\d{6,}-\d{6}-[a-f0-9]{16,}"),               # access token Mercado Pago de teste
]
SCANNED = ["worker/psp-failover.mjs", "worker/asaas-boleto.mjs", "worker/asaas-webhook-safety.mjs",
           "worker/asaas-pix-refund-auth.mjs", "worker/cloudflare-worker.recovered.mjs", "worker/cloudflare-worker.compat.mjs"]

NODE = r'''
import { paymentProviderCandidates, selectPaymentProvider } from "./worker/cloudflare-worker.recovered.mjs";
import { createCircuitBreaker, pspContinuityPlan, runCheckoutWithFailover } from "./worker/psp-failover.mjs";
const out = {};
const syn = (n) => "synthetic-" + n + "-" + "x".repeat(40);
const full = { MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: syn("mp"), MERCADOPAGO_WEBHOOK_SECRET: syn("mpw"),
  ASAAS_ENV: "production", ASAAS_API_KEY: syn("as"), ASAAS_WEBHOOK_TOKEN: syn("asw"), ASAAS_WEBHOOK_PATH_SECRET: "p".repeat(48),
  PAYMENT_PROVIDER_POOL: "mercadopago,asaas" };
const ready = (env) => paymentProviderCandidates(env, { production: true }).filter((c) => c.ready).map((c) => c.provider);
out.ready_full = ready(full);
out.selected_full = selectPaymentProvider(full, { production: true, operationKey: "a" }).provider;
out.selected_other_key = selectPaymentProvider(full, { production: true, operationKey: "zzzz" }).provider;
const noPath = { ...full }; delete noPath.ASAAS_WEBHOOK_PATH_SECRET;
out.ready_no_path_secret = ready(noPath);
out.ready_none = ready({});
const mem = new Map(); const store = { async get(k) { return mem.get(k) ?? null; }, async put(k, v) { mem.set(k, String(v)); } };
const breaker = createCircuitBreaker({ store });
const cands = paymentProviderCandidates(full, { production: true });
out.plan_redundant = (await pspContinuityPlan({ candidates: cands, breaker, lockOpen: true })).mode;
out.plan_locked = (await pspContinuityPlan({ candidates: cands, breaker, lockOpen: false })).mode;
out.plan_single = (await pspContinuityPlan({ candidates: paymentProviderCandidates(noPath, { production: true }), breaker, lockOpen: true })).quorum_ok;
const calls = [];
const invoke = async (p) => { calls.push(p); return { status: 201, body: { accepted: true, checkout_url: "https://example.invalid/" + p } }; };
const locked = await runCheckoutWithFailover({ lockOpen: async () => false, candidates: cands, breaker, invoke });
out.locked_error = locked.body.error; out.locked_calls = calls.length;
const amb = []; const ambiguous = await runCheckoutWithFailover({ lockOpen: async () => true, candidates: cands, breaker: createCircuitBreaker({ store: { async get() { return null; }, async put() {} } }),
  invoke: async (p) => { amb.push(p); return { status: 503, body: { error: "checkout_provider_uncertain", provider_error: "aborted due to timeout" } }; } });
out.ambiguous_calls = amb; out.ambiguous_suppressed = ambiguous.body.fallback_suppressed === true;
const down = createCircuitBreaker({ store, forcedDown: ["mercadopago", "asaas"] });
const dc = []; const both = await runCheckoutWithFailover({ lockOpen: async () => true, candidates: cands, breaker: down, invoke: async (p) => { dc.push(p); return {}; } });
out.both_down = { status: both.status, error: both.body.error, calls: dc.length };
out.plan_fail_closed = (await pspContinuityPlan({ candidates: cands, breaker: down, lockOpen: true })).mode;
console.log("PSP_GATE_JSON " + JSON.stringify(out));
process.exit(0);
'''


def main() -> int:
    ok = True

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        ok &= bool(cond)
        print(f"PSP_GATE {name} {'PASS' if cond else 'FAIL'}{(' ' + detail) if detail and not cond else ''}", flush=True)

    try:
        c = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"PSP_GATE evidence FAIL {exc}")
        return 2
    check("evidence_quorum_2", c.get("min_ready_psp_quorum") == 2)
    check("evidence_order", c.get("fallback_order") == ["mercadopago", "asaas"])
    check("evidence_ambiguous_never_fails_over", c.get("ambiguous_never_fails_over") is True)
    check("evidence_lock_blocks_all", c.get("commercial_lock_blocks_all_providers") is True)
    check("evidence_refund_intent", c.get("asaas_refund_requires_persisted_intent") is True)

    p = subprocess.run(["node", "--import", "./tests/t4_sim/register.mjs", "--input-type=module", "-e", NODE],
                       cwd=ROOT, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL,
                       env={"PATH": __import__("os").environ.get("PATH", ""), "HOME": "/tmp"})
    m = re.search(r"^PSP_GATE_JSON (.*)$", p.stdout, re.M)
    if not m:
        print(f"PSP_GATE node FAIL rc={p.returncode} {p.stderr[-400:]}")
        return 2
    r = json.loads(m.group(1))
    check("bundle_two_ready", r["ready_full"] == ["mercadopago", "asaas"], str(r["ready_full"]))
    check("bundle_fixed_order", r["selected_full"] == "mercadopago" and r["selected_other_key"] == "mercadopago",
          f"{r['selected_full']}/{r['selected_other_key']}")
    check("asaas_requires_path_secret", r["ready_no_path_secret"] == ["mercadopago"], str(r["ready_no_path_secret"]))
    check("nothing_ready_without_config", r["ready_none"] == [], str(r["ready_none"]))
    check("plan_redundant", r["plan_redundant"] == "redundant", r["plan_redundant"])
    check("plan_single_below_quorum", r["plan_single"] is False)
    check("plan_sales_locked", r["plan_locked"] == "sales_locked", r["plan_locked"])
    check("lock_blocks_both_providers", r["locked_error"] == "sales_globally_blocked" and r["locked_calls"] == 0,
          f"{r['locked_error']}/{r['locked_calls']}")
    check("ambiguous_no_second_provider", r["ambiguous_calls"] == ["mercadopago"] and r["ambiguous_suppressed"], str(r["ambiguous_calls"]))
    check("both_down_fail_closed", r["both_down"] == {"status": 503, "error": "payment_capacity_unavailable", "calls": 0}, str(r["both_down"]))
    check("plan_fail_closed", r["plan_fail_closed"] == "fail_closed", r["plan_fail_closed"])

    leaks = []
    for rel in SCANNED:
        text = (ROOT / rel).read_text(encoding="utf-8", errors="replace")
        leaks += [f"{rel}:{pat.pattern[:20]}" for pat in SECRET_PATTERNS if pat.search(text)]
    check("no_provider_secret_in_source", not leaks, ",".join(leaks))

    print("PSP_TWO_PROVIDERS_GATE: " + ("PASS" if ok else "FAIL"), flush=True)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
