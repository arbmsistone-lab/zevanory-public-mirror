// B05/B08 — failover de PSP (unidade, sem rede). Cada teste prova uma regra com asserção funcional.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  PSP_FALLBACK_ORDER, breakerConfigFromEnv, classifyCheckoutOutcome, breakerFailureKind, constantTimeEqual, createCircuitBreaker,
  idempotencyKeyForOrder, planPspOrder, pspCommercialLockOpen, pspContinuityPlan, runCheckoutWithFailover,
} from "../../worker/psp-failover.mjs";

const READY = [{ provider: "stripe", ready: true }, { provider: "asaas", ready: true }, { provider: "mercadopago", ready: true }];
const ok = (provider) => ({ status: 201, body: { accepted: true, checkout_url: `https://${provider}.example/checkout/1`, order_id: "o" } });
const uncertain = (extra = {}) => ({ status: 503, body: { error: "checkout_provider_uncertain", accepted: false, reconciliation_required: true, ...extra } });

function memStore() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, String(v)); } };
}
function clock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}
function harness({ responses = {}, lock = true, candidates = READY, breakerOpts = {} } = {}) {
  const c = clock();
  const breaker = createCircuitBreaker({ store: memStore(), now: c.now, threshold: 3, windowMs: 60_000, cooldownMs: 30_000, ...breakerOpts });
  const calls = [];
  const lockState = { open: lock };
  const invoke = async (provider) => {
    calls.push(provider);
    const r = responses[provider];
    return typeof r === "function" ? r(calls.length) : (r || ok(provider));
  };
  const run = (extra = {}) => runCheckoutWithFailover({ lockOpen: async () => (typeof lockState.open === "function" ? lockState.open(calls) : lockState.open), candidates, breaker, invoke, ...extra });
  return { c, breaker, calls, run, lockState };
}

test("F01 ordem fixa: com os dois saudáveis só o Mercado Pago é chamado (Asaas nunca)", async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(out.status, 201);
  assert.equal(out.body.provider, "mercadopago");
  assert.equal(out.body.failover, false);
  assert.deepEqual(h.calls, ["mercadopago"]);
});

test("F02 ordem determinística independe da ordem dos candidatos e exclui stripe", () => {
  assert.deepEqual(PSP_FALLBACK_ORDER, ["mercadopago", "asaas"]);
  assert.deepEqual(planPspOrder(READY), ["mercadopago", "asaas"]);
  assert.deepEqual(planPspOrder([...READY].reverse()), ["mercadopago", "asaas"]);
  assert.deepEqual(planPspOrder([{ provider: "asaas", ready: true }, { provider: "mercadopago", ready: false }]), ["asaas"]);
  assert.deepEqual(planPspOrder(READY, { only: ["asaas"] }), ["asaas"]);
});

test("F03 disjuntor do MP aberto: vai direto ao Asaas sem tocar no MP", async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.breaker.recordFailure("mercadopago", "5xx");
  assert.equal((await h.breaker.state("mercadopago")).state, "open");
  const out = await h.run();
  assert.equal(out.status, 201);
  assert.equal(out.body.provider, "asaas");
  assert.equal(out.body.failover, true);
  assert.deepEqual(h.calls, ["asaas"]);
});

test("F04 MP 'não tentado' (sem pedido gravado, provedor não chamado) => Asaas no mesmo request", async () => {
  const h = harness({ responses: { mercadopago: { status: 503, body: { error: "checkout_provider_unavailable" } } } });
  const out = await h.run();
  assert.equal(out.body.provider, "asaas");
  assert.deepEqual(h.calls, ["mercadopago", "asaas"]);
});

test("F05 MP timeout no meio da requisição (ambíguo) => NUNCA cria segunda cobrança no Asaas", async () => {
  const h = harness({ responses: { mercadopago: uncertain({ provider_error: "The operation was aborted due to timeout" }) } });
  const out = await h.run();
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "checkout_provider_uncertain");
  assert.equal(out.body.fallback_suppressed, true);
  assert.equal(out.body.reconciliation_required, true);
  assert.deepEqual(h.calls, ["mercadopago"], "Asaas não pode ser chamado depois de resultado ambíguo");
  const s = await h.breaker.state("mercadopago");
  assert.equal(s.failures, 1, "timeout conta no disjuntor");
});

test("F06 resposta inválida e falha ao persistir também são ambíguas: sem failover", async () => {
  for (const error of ["checkout_response_invalid", "checkout_persist_failed"]) {
    const h = harness({ responses: { mercadopago: { status: 503, body: { error } } } });
    const out = await h.run();
    assert.equal(out.body.fallback_suppressed, true, error);
    assert.deepEqual(h.calls, ["mercadopago"], error);
  }
});

test("F07 MP fora (5xx repetido): abre depois de 3 falhas e o 4º pedido vai ao Asaas sem chamar o MP", async () => {
  const h = harness({ responses: { mercadopago: uncertain({ provider_error: "mercadopago_preference_503_unavailable" }) } });
  for (let i = 0; i < 3; i++) {
    const out = await h.run();
    assert.equal(out.body.fallback_suppressed, true);
  }
  assert.equal((await h.breaker.state("mercadopago")).state, "open");
  const out = await h.run();
  assert.equal(out.status, 201);
  assert.equal(out.body.provider, "asaas");
  assert.deepEqual(h.calls, ["mercadopago", "mercadopago", "mercadopago", "asaas"]);
});

test("F08 os dois fora => 503 fail-closed, sem chamar provedor com disjuntor aberto", async () => {
  const h = harness();
  for (const p of ["mercadopago", "asaas"]) for (let i = 0; i < 3; i++) await h.breaker.recordFailure(p, "timeout");
  const out = await h.run();
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "payment_capacity_unavailable");
  assert.equal(out.body.fail_closed, true);
  assert.deepEqual(h.calls, []);
  const none = harness({ candidates: [{ provider: "mercadopago", ready: false }, { provider: "asaas", ready: false }] });
  const out2 = await none.run();
  assert.equal(out2.body.error, "payment_capacity_unavailable");
  assert.deepEqual(none.calls, []);
});

test("F09 os dois 'não tentados' => 503 fail-closed", async () => {
  const na = { status: 503, body: { error: "checkout_environment_invalid" } };
  const h = harness({ responses: { mercadopago: na, asaas: na } });
  const out = await h.run();
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "payment_capacity_unavailable");
});

test("F10 trava comercial fechada bloqueia os DOIS provedores (nenhum é chamado)", async () => {
  const h = harness({ lock: false });
  const out = await h.run();
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "sales_globally_blocked");
  assert.deepEqual(h.calls, []);
});

test("F11 trava fechada com só o Asaas pronto: Asaas também bloqueado", async () => {
  const h = harness({ lock: false, candidates: [{ provider: "mercadopago", ready: false }, { provider: "asaas", ready: true }] });
  const out = await h.run();
  assert.equal(out.body.error, "sales_globally_blocked");
  assert.deepEqual(h.calls, []);
});

test("F12 trava fechada com disjuntor do MP aberto: o failover não reabre vendas", async () => {
  const h = harness({ lock: false });
  for (let i = 0; i < 3; i++) await h.breaker.recordFailure("mercadopago", "5xx");
  const out = await h.run();
  assert.equal(out.body.error, "sales_globally_blocked");
  assert.deepEqual(h.calls, []);
});

test("F13 trava reavaliada antes de CADA tentativa: fechou durante o failover => Asaas não é chamado", async () => {
  const h = harness({ responses: { mercadopago: { status: 503, body: { error: "checkout_provider_unavailable" } } } });
  h.lockState.open = (calls) => calls.length === 0; // aberta só para a primeira tentativa
  const out = await h.run();
  assert.equal(out.body.error, "sales_globally_blocked");
  assert.deepEqual(h.calls, ["mercadopago"]);
});

test("F14 resultado terminal (conflito/409/trava do handler) não faz failover", async () => {
  for (const r of [{ status: 409, body: { error: "request_id_provider_conflict" } }, { status: 503, body: { error: "sales_globally_blocked" } }, { status: 503, body: { error: "checkout_disabled" } }, { status: 400, body: { error: "invalid_checkout_request" } }]) {
    const h = harness({ responses: { mercadopago: r } });
    const out = await h.run();
    assert.equal(out.status, r.status);
    assert.deepEqual(h.calls, ["mercadopago"], r.body.error);
  }
});

test("F15 boleto: plano só com Asaas; MP nunca chamado", async () => {
  const h = harness();
  const out = await h.run({ only: ["asaas"] });
  assert.equal(out.body.provider, "asaas");
  assert.deepEqual(h.calls, ["asaas"]);
});

test("F16 disjuntor: limiar, janela, meia-abertura com uma sondagem, sucesso fecha e falha reabre", async () => {
  const h = harness();
  const b = h.breaker;
  await b.recordFailure("mercadopago", "5xx");
  await b.recordFailure("mercadopago", "5xx");
  assert.equal((await b.state("mercadopago")).state, "closed", "2 falhas não abrem com limiar 3");
  h.c.advance(61_000);
  await b.recordFailure("mercadopago", "5xx");
  assert.equal((await b.state("mercadopago")).state, "closed", "falhas fora da janela não contam");
  await b.recordFailure("mercadopago", "timeout");
  await b.recordFailure("mercadopago", "network");
  assert.equal((await b.state("mercadopago")).state, "open");
  assert.equal((await b.state("mercadopago")).allow, false);
  h.c.advance(30_001);
  const half = await b.state("mercadopago");
  assert.equal(half.state, "half_open");
  assert.equal(half.allow, true);
  await b.recordFailure("mercadopago", "5xx");
  assert.equal((await b.state("mercadopago")).state, "open", "sondagem falha reabre");
  h.c.advance(30_001);
  await b.recordSuccess("mercadopago");
  const closed = await b.state("mercadopago");
  assert.equal(closed.state, "closed");
  assert.equal(closed.failures, 0);
});

test("F17 disjuntor ignora rejeição 4xx (configuração) e tipos desconhecidos", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.breaker.recordFailure("asaas", null);
  for (let i = 0; i < 5; i++) await h.breaker.recordFailure("asaas", "bogus");
  assert.equal((await h.breaker.state("asaas")).state, "closed");
  assert.equal(breakerFailureKind({ body: { provider_http_status: 400 } }), null);
  assert.equal(breakerFailureKind({ body: { provider_http_status: 502 } }), "5xx");
  assert.equal(breakerFailureKind({ body: { provider_http_status: 429 } }), "throttled");
  assert.equal(breakerFailureKind({ body: { provider_error: "mercadopago_preference_500_x" } }), "5xx");
  assert.equal(breakerFailureKind({ body: { provider_error: "mercadopago_preference_401_unauthorized" } }), null);
  assert.equal(breakerFailureKind({ body: { provider_error: "The operation was aborted due to timeout" } }), "timeout");
  assert.equal(breakerFailureKind({ body: {} }), "network");
});

test("F18 classificação dos resultados dos handlers", () => {
  assert.equal(classifyCheckoutOutcome(ok("x")).class, "success");
  assert.equal(classifyCheckoutOutcome({ status: 201, body: { accepted: true, checkout_url: "http://inseguro" } }).class, "terminal");
  assert.equal(classifyCheckoutOutcome({ status: 503, body: { error: "checkout_provider_unavailable" } }).class, "not_attempted");
  assert.equal(classifyCheckoutOutcome(uncertain()).class, "ambiguous");
  assert.equal(classifyCheckoutOutcome({ status: 503, body: { error: "boleto_provider_unavailable", provider_http_status: 503 } }).breakerFailure, "5xx");
});

test("F19 sucesso depois de falhas zera o disjuntor; sucesso limpo não grava (economia de KV)", async () => {
  const store = memStore();
  const c = clock();
  const b = createCircuitBreaker({ store, now: c.now });
  await b.recordSuccess("mercadopago");
  assert.equal(store.map.size, 0);
  await b.recordFailure("mercadopago", "5xx");
  assert.equal(store.map.size, 1);
  await b.recordSuccess("mercadopago");
  assert.deepEqual(JSON.parse(store.map.get("psp:circuit:v1:mercadopago")), { failures: [], opened_at: null });
});

test("F20 chave de idempotência estável por pedido; trava lê SALE_GLOBALLY_ENABLED", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(idempotencyKeyForOrder(id), `zevanory-order-${id}`);
  assert.equal(idempotencyKeyForOrder(id.toUpperCase()), `zevanory-order-${id}`);
  assert.equal(idempotencyKeyForOrder("x"), "");
  assert.equal(pspCommercialLockOpen({ SALE_GLOBALLY_ENABLED: "true" }), true);
  assert.equal(pspCommercialLockOpen({ SALE_GLOBALLY_ENABLED: "false" }), false);
  assert.equal(pspCommercialLockOpen({}), false);
});

test("F21 comparação em tempo constante: sempre timingSafeEqual sobre resumos de 32 bytes, também com comprimentos diferentes", () => {
  const orig = crypto.timingSafeEqual;
  const calls = [];
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return orig(a, b); };
  try {
    const secret = "s".repeat(48);
    assert.equal(constantTimeEqual(secret, secret), true);
    assert.equal(constantTimeEqual(secret, secret.slice(0, 47) + "t"), false);
    assert.equal(constantTimeEqual(secret, "curto"), false);
    assert.equal(constantTimeEqual("", ""), false, "segredo vazio nunca autentica");
    assert.equal(calls.length, 4, "toda comparação passa por timingSafeEqual");
    assert.ok(calls.every(([a, b]) => a === 32 && b === 32), JSON.stringify(calls));
  } finally {
    crypto.timingSafeEqual = orig;
  }
});

test("F22 plano de continuidade: modos e quórum de 2 PSPs, sem segredos", async () => {
  const c = clock();
  const breaker = createCircuitBreaker({ store: memStore(), now: c.now });
  const redundant = await pspContinuityPlan({ candidates: READY, breaker, lockOpen: true });
  assert.equal(redundant.mode, "redundant");
  assert.equal(redundant.quorum_ok, true);
  assert.deepEqual(redundant.usable_providers, ["mercadopago", "asaas"]);
  for (let i = 0; i < 3; i++) await breaker.recordFailure("mercadopago", "5xx");
  assert.equal((await pspContinuityPlan({ candidates: READY, breaker, lockOpen: true })).mode, "degraded");
  for (let i = 0; i < 3; i++) await breaker.recordFailure("asaas", "5xx");
  assert.equal((await pspContinuityPlan({ candidates: READY, breaker, lockOpen: true })).mode, "fail_closed");
  const locked = await pspContinuityPlan({ candidates: READY, breaker, lockOpen: false });
  assert.equal(locked.mode, "sales_locked");
  assert.equal((await pspContinuityPlan({ candidates: [{ provider: "mercadopago", ready: true }], breaker, lockOpen: true })).quorum_ok, false);
  assert.doesNotMatch(JSON.stringify(redundant), /token|secret|key/i);
});

test("F23 saúde explícita: MP marcado fora (env) => Asaas direto, MP nunca chamado; os dois fora => 503 fail-closed", async () => {
  const cfg = breakerConfigFromEnv({ PSP_FORCE_DOWN: " MercadoPago , stripe" });
  assert.deepEqual(cfg.forcedDown, ["mercadopago"], "só PSPs do plano; stripe ignorado");
  const h = harness({ breakerOpts: { forcedDown: cfg.forcedDown } });
  const st = await h.breaker.state("mercadopago");
  assert.equal(st.state, "forced_down");
  assert.equal(st.allow, false);
  const out = await h.run();
  assert.equal(out.body.provider, "asaas");
  assert.deepEqual(h.calls, ["asaas"]);
  const both = harness({ breakerOpts: { forcedDown: ["mercadopago", "asaas"] } });
  const out2 = await both.run();
  assert.equal(out2.status, 503);
  assert.equal(out2.body.error, "payment_capacity_unavailable");
  assert.deepEqual(out2.body.skipped.map((s) => s.reason), ["forced_down", "forced_down"]);
  assert.deepEqual(both.calls, []);
});

test("F24 saúde explícita por KV (psp:health:v1:<p>) e retorno ao normal quando removida", async () => {
  const store = memStore();
  const c = clock();
  const b = createCircuitBreaker({ store, now: c.now });
  await store.put("psp:health:v1:mercadopago", JSON.stringify({ status: "down" }));
  assert.equal((await b.state("mercadopago")).state, "forced_down");
  assert.equal((await b.state("asaas")).state, "closed");
  await store.put("psp:health:v1:mercadopago", JSON.stringify({ status: "up" }));
  assert.equal((await b.state("mercadopago")).state, "closed");
  await store.put("psp:health:v1:mercadopago", "não-json");
  assert.equal((await b.state("mercadopago")).state, "closed", "valor ilegível não derruba (o disjuntor automático continua valendo)");
});
