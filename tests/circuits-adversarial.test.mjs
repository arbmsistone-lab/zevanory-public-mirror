// B04 "Circuitos A/B" — testes adversariais locais (Roteiro R2 §B, método F01).
// Escopo: somente a lógica de circuito/seleção de rota que existe no código. Não há segundo provedor
// de pagamento (B03), portanto NÃO há prova de transferência real entre rotas aqui.
// Oráculo externo = estado observável: status HTTP/corpo, gravações em KV, chamadas de rede simuladas,
// flag global aplicada ao bundle. Nenhum teste lê texto do código-fonte.
// Guardas cobertas:
//   G1 chave de vendas (worker/sales-control.mjs: readSalesSwitch, /api/sales/status, applySalesSwitch)
//   G2 portão de checkout (worker/commercial-checkout-guard.mjs: evaluateCheckout, verifyProductionToken,
//      isCheckoutRoute, requiresPilotDenial)
//   G3 roteador de continuidade (worker/continuity-router.mjs: primária/fallback e quórum)
//   G4 disjuntor de voz (worker/voice-provider-router.mjs: primária→secundária, abertura e cooldown)
//   G5 classificação de prontidão (worker/production-health-safety.mjs) — nunca autoriza checkout
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readSalesSwitch, resetSalesSwitchCache, applySalesSwitch, handleSalesControl } from "../worker/sales-control.mjs";
import { REQUIRED, evaluateCheckout, verifyProductionToken, isCheckoutRoute, requiresPilotDenial, allowCheckout } from "../worker/commercial-checkout-guard.mjs";
import { buildContinuityPlan, continuityHttpResponse } from "../worker/continuity-router.mjs";
import { ttsBytesWithFailover, voiceProviderStatus } from "../worker/voice-provider-router.mjs";
import { safeClosedCommercialStaging } from "../worker/production-health-safety.mjs";

const H = 3600_000;
const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

// Congela Date.now() para que os limites de tempo sejam exatos (o módulo também usa Date.now()).
async function atClock(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
}

// KV observável: registra leituras/gravações; aceita atraso por chave e falha forçada.
function kvStore(initial = {}, { delays = {}, throwOn = null } = {}) {
  const map = new Map(Object.entries(initial));
  const log = [];
  return {
    map, log,
    async get(k) {
      log.push(["get", k]);
      if (throwOn && throwOn(k)) throw new Error("kv_unavailable");
      if (delays[k]) await delays[k]();
      return map.has(k) ? map.get(k) : null;
    },
    async put(k, v) { log.push(["put", k]); map.set(k, v); }
  };
}

const ownerRecord = (at = T0) => ({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner", at: iso(at), ref: "github:issue-comment:123456" });
const preflight = (at, ok = true) => JSON.stringify({ ok, at: iso(at), checks: [] });
const salesEnv = (switchRec, pre) => ({
  ZEVANORY_PRIVATE_ARTIFACTS: kvStore({
    ...(switchRec === undefined ? {} : { "sales:open:v1": typeof switchRec === "string" ? switchRec : JSON.stringify(switchRec) }),
    ...(pre === undefined ? {} : { "zpc-sales-preflight:v1": pre })
  })
});
async function readAt(env, now) {
  resetSalesSwitchCache();
  return atClock(now, () => readSalesSwitch(env, now));
}

// ---------------------------------------------------------------- G1 chave de vendas
// Tabela de decisão G1 (entrada → enabled):
//   sem registro / lixo / enabled!=true / autorização incompleta / preflight ausente, vermelho, corrompido,
//   vencido (>= 3h), datado no futuro, KV lançando erro                                → false
//   registro completo + preflight ok:true com idade em [0, 3h)                          → true

test("G1 par positivo/negativo: registro completo + preflight verde abre; cada guarda isolada fecha", async () => {
  const pos = await readAt(salesEnv(ownerRecord(), preflight(T0 - 60_000)), T0);
  assert.equal(pos.enabled, true);
  assert.equal(pos.authorized, true);
  const cases = {
    sem_registro: salesEnv(undefined, preflight(T0 - 60_000)),
    lixo: salesEnv("{not json", preflight(T0 - 60_000)),
    enabled_string: salesEnv({ ...ownerRecord(), enabled: "true" }, preflight(T0 - 60_000)),
    sem_frase: salesEnv({ ...ownerRecord(), authorization: "liberar vendas" }, preflight(T0 - 60_000)),
    ref_curta: salesEnv({ ...ownerRecord(), ref: "x" }, preflight(T0 - 60_000)),
    autorizacao_futura: salesEnv(ownerRecord(T0 + 60_001), preflight(T0 - 60_000)),
    preflight_ausente: salesEnv(ownerRecord(), undefined),
    preflight_vermelho: salesEnv(ownerRecord(), preflight(T0 - 60_000, false)),
    preflight_corrompido: salesEnv(ownerRecord(), "{{{"),
    preflight_sem_data: salesEnv(ownerRecord(), JSON.stringify({ ok: true })),
    preflight_ok_string: salesEnv(ownerRecord(), JSON.stringify({ ok: "true", at: iso(T0 - 1) }))
  };
  for (const [name, env] of Object.entries(cases)) {
    const r = await readAt(env, T0);
    assert.equal(r.enabled, false, name);
  }
});

test("G1 limite de TTL do preflight: 3h-1ms abre, exatamente 3h e 3h+1ms fecham", async () => {
  assert.equal((await readAt(salesEnv(ownerRecord(), preflight(T0 - 3 * H + 1)), T0)).enabled, true);
  assert.equal((await readAt(salesEnv(ownerRecord(), preflight(T0 - 3 * H)), T0)).enabled, false);
  assert.equal((await readAt(salesEnv(ownerRecord(), preflight(T0 - 3 * H - 1)), T0)).enabled, false);
  assert.equal((await readAt(salesEnv(ownerRecord(), preflight(T0)), T0)).enabled, true, "idade zero é fresco");
});

test("G1 preflight datado no futuro (relógio adiantado/corrompido) nunca conta como fresco", async () => {
  for (const ahead of [1, 60_000, 24 * H, 365 * 24 * H]) {
    const r = await readAt(salesEnv(ownerRecord(), preflight(T0 + ahead)), T0);
    assert.equal(r.enabled, false, "futuro +" + ahead + "ms");
    assert.equal(r.blocked, "preflight_not_green");
  }
});

test("G1 KV indisponível ou ausente fecha (fail-closed) sem lançar", async () => {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kvStore({ "sales:open:v1": JSON.stringify(ownerRecord()) }, { throwOn: () => true }) };
  assert.equal((await readAt(env, T0)).enabled, false);
  const envPre = { ZEVANORY_PRIVATE_ARTIFACTS: kvStore({ "sales:open:v1": JSON.stringify(ownerRecord()), "zpc-sales-preflight:v1": preflight(T0) }, { throwOn: (k) => k === "zpc-sales-preflight:v1" }) };
  assert.equal((await readAt(envPre, T0)).enabled, false);
  assert.equal((await readAt({}, T0)).enabled, false);
  assert.equal((await readAt(undefined, T0)).enabled, false);
});

test("G1 cache: fechamento do dono propaga em exatamente 10 s (9.999 ms ainda em cache, 10.000 ms relido)", async () => {
  const env = salesEnv(ownerRecord(), preflight(T0 - 60_000));
  resetSalesSwitchCache();
  assert.equal((await atClock(T0, () => readSalesSwitch(env, T0))).enabled, true);
  env.ZEVANORY_PRIVATE_ARTIFACTS.map.set("sales:open:v1", JSON.stringify({ enabled: false }));
  assert.equal((await atClock(T0 + 9_999, () => readSalesSwitch(env, T0 + 9_999))).enabled, true, "janela documentada de cache");
  assert.equal((await atClock(T0 + 10_000, () => readSalesSwitch(env, T0 + 10_000))).enabled, false);
});

test("G1 relógio voltando no tempo não prende o cache aberto após o fechamento", async () => {
  const env = salesEnv(ownerRecord(), preflight(T0 - 60_000));
  resetSalesSwitchCache();
  assert.equal((await atClock(T0, () => readSalesSwitch(env, T0))).enabled, true);
  env.ZEVANORY_PRIVATE_ARTIFACTS.map.set("sales:open:v1", JSON.stringify({ enabled: false }));
  const back = T0 - 1 * H;
  assert.equal((await atClock(back, () => readSalesSwitch(env, back))).enabled, false);
});

test("G1 corrida: leitura lenta iniciada antes do fechamento fica limitada à janela de 10 s", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kvStore({ "sales:open:v1": JSON.stringify(ownerRecord()), "zpc-sales-preflight:v1": preflight(T0 - 60_000) }, { delays: { "zpc-sales-preflight:v1": () => gate } }) };
  resetSalesSwitchCache();
  await atClock(T0, async () => {
    const slow = readSalesSwitch(env, T0);              // lê "aberto" e espera o preflight
    await new Promise((r) => setImmediate(r));
    env.ZEVANORY_PRIVATE_ARTIFACTS.map.set("sales:open:v1", JSON.stringify({ enabled: false }));
    resetSalesSwitchCache();
    const fast = await readSalesSwitch(env, T0 + 1);    // vê o fechamento
    assert.equal(fast.enabled, false);
    release();
    await slow;                                         // sobrescreve o cache com o valor antigo (corrida conhecida)
  });
  const after = await atClock(T0 + 10_000, () => readSalesSwitch(env, T0 + 10_000));
  assert.equal(after.enabled, false, "a corrida não pode manter vendas abertas além de 10 s");
});

test("G1 /api/sales/status: chave fechada → open:false; chave aberta sem prova financeira → open:false com motivo", async () => {
  resetSalesSwitchCache();
  const closed = await atClock(T0, () => handleSalesControl(new Request("https://x/api/sales/status"), { ...salesEnv(undefined, undefined) }));
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { open: false, requested: false, blocked: null, revision: null });
  resetSalesSwitchCache();
  const env = { ...salesEnv(ownerRecord(), preflight(Date.now() - 60_000)), ABSOLUTE_RELEASE_APPROVED: "true", PRE_SALE_GATES_APPROVED: "true", MERCADOPAGO_ENV: "production" };
  const open = await handleSalesControl(new Request("https://x/api/sales/status"), env);
  const body = await open.json();
  assert.equal(body.open, false);
  assert.equal(body.requested, true);
  assert.equal(body.blocked, "release_or_financial_proof_pending");
  resetSalesSwitchCache();
  const fut = { ...salesEnv(ownerRecord(), preflight(Date.now() + 24 * H)), ABSOLUTE_RELEASE_APPROVED: "true", PRE_SALE_GATES_APPROVED: "true", MERCADOPAGO_ENV: "production" };
  const futBody = await (await handleSalesControl(new Request("https://x/api/sales/status"), fut)).json();
  assert.equal(futBody.open, false);
  assert.equal(futBody.blocked, "preflight_not_green");
  const post = await handleSalesControl(new Request("https://x/api/sales/status", { method: "POST" }), env);
  assert.equal(post.status, 405);
  assert.equal(env.ZEVANORY_PRIVATE_ARTIFACTS.log.filter(([op]) => op === "put").length, 0, "leitura de status nunca grava KV");
});

test("G1 applySalesSwitch só liga a flag global com enabled===true estrito", () => {
  for (const v of [null, undefined, {}, { enabled: "true" }, { enabled: 1 }, { enabled: false }]) {
    assert.equal(applySalesSwitch(v), false);
    assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, false);
  }
  assert.equal(applySalesSwitch({ enabled: true }), true);
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, true);
  applySalesSwitch(null);
});

// ---------------------------------------------------------------- G2 portão de checkout
// Tabela de decisão G2: allowed ⇔ os 10 sinais em REQUIRED são true; token só é verificado (rede) quando os
// outros 9 já são true; preflight fresco ⇔ ok===true ∧ at<=now ∧ now-at<3h.
const checkoutEnv = (pre) => ({
  SALE_GLOBALLY_ENABLED: "true", PRE_SALE_GATES_APPROVED: "true", ABSOLUTE_RELEASE_APPROVED: "true",
  CHECKOUT_ENABLED: "true", FINANCIAL_EVENTS_ENABLED: "true", MERCADOPAGO_ENV: "production",
  ZEVANORY_PRIVATE_ARTIFACTS: kvStore(pre === undefined ? {} : { "zpc-sales-preflight:v1": pre })
});
// P23: registro fiscal COMPLETO só de teste; o registro real (data/p23/fiscal-process.json) está NAO_DEFINIDO e fecha o
// checkout por si só (tests/p23-ecommerce-legal.test.mjs). Aqui ele é injetado para isolar os demais sinais.
const FISCAL_OK = { status: "DEFINIDO", decision: { regime: "fixture de teste", documento_fiscal: "fixture de teste", emissor: "fixture de teste", decided_by: "proprietario", accountant_ref: "fixture de teste", decided_at: "2026-10-01", procedure_ref: { kind: "repo", ref: "docs/fixture.md", contains: "fixture de teste" }, test_order_ref: "fixture de teste", owner_approval_ref: "fixture de teste" } };
const countingVerify = (result) => { const f = async () => { f.calls++; return result; }; f.calls = 0; return f; };

test("G2 par positivo/negativo por sinal: cada variável de ambiente isolada fecha e não toca a rede", async () => {
  const ok = countingVerify(true);
  assert.equal((await evaluateCheckout(checkoutEnv(preflight(T0 - 1000)), { enabled: true }, { now: T0, fiscal: FISCAL_OK, verify: ok })).allowed, true);
  assert.equal(ok.calls, 1);
  const breaks = {
    PRE_SALE_GATES_APPROVED: "false", ABSOLUTE_RELEASE_APPROVED: "", CHECKOUT_ENABLED: "yes",
    FINANCIAL_EVENTS_ENABLED: "true ", MERCADOPAGO_ENV: "sandbox"
  };
  for (const [k, v] of Object.entries(breaks)) {
    const verify = countingVerify(true);
    const r = await evaluateCheckout({ ...checkoutEnv(preflight(T0 - 1000)), [k]: v }, { enabled: true }, { now: T0, fiscal: FISCAL_OK, verify });
    assert.equal(r.allowed, false, k);
    assert.equal(verify.calls, 0, "sem rede quando " + k + " fecha");
  }
  const tokenNo = countingVerify(false);
  assert.equal((await evaluateCheckout(checkoutEnv(preflight(T0 - 1000)), { enabled: true }, { now: T0, fiscal: FISCAL_OK, verify: tokenNo })).allowed, false);
});

test("G2 chave do dono: KV desligado fecha mesmo com SALE_GLOBALLY_ENABLED; authorized sem env abre", async () => {
  const v = countingVerify(true);
  for (const sw of [null, undefined, {}, { enabled: false, authorized: true }, { enabled: "true" }]) {
    assert.equal((await evaluateCheckout(checkoutEnv(preflight(T0 - 1000)), sw, { now: T0, fiscal: FISCAL_OK, verify: v })).allowed, false);
  }
  assert.equal(v.calls, 0);
  const env = { ...checkoutEnv(preflight(T0 - 1000)), SALE_GLOBALLY_ENABLED: "false" };
  assert.equal((await evaluateCheckout(env, { enabled: true }, { now: T0, fiscal: FISCAL_OK, verify: countingVerify(true) })).allowed, false);
  assert.equal((await evaluateCheckout(env, { enabled: true, authorized: true }, { now: T0, fiscal: FISCAL_OK, verify: countingVerify(true) })).allowed, true);
});

test("G2 limites do preflight: idade 0 e 3h-1ms abrem; 3h, 3h+1ms, +1ms no futuro, corrompido e KV com erro fecham", async () => {
  const at = async (pre, env) => (await evaluateCheckout(env || checkoutEnv(pre), { enabled: true }, { now: T0, fiscal: FISCAL_OK, verify: async () => true })).allowed;
  assert.equal(await at(preflight(T0)), true);
  assert.equal(await at(preflight(T0 - 3 * H + 1)), true);
  assert.equal(await at(preflight(T0 - 3 * H)), false);
  assert.equal(await at(preflight(T0 - 3 * H - 1)), false);
  assert.equal(await at(preflight(T0 + 1)), false);
  assert.equal(await at(preflight(T0 - 1000, false)), false);
  assert.equal(await at("not-json"), false);
  assert.equal(await at(JSON.stringify({ ok: true, at: "ontem" })), false);
  assert.equal(await at(undefined), false);
  const broken = { ...checkoutEnv(), ZEVANORY_PRIVATE_ARTIFACTS: kvStore({}, { throwOn: () => true }) };
  assert.equal(await at(null, broken), false);
});

test("G2 allowCheckout: valores truthy que não são true estrito nunca abrem", () => {
  const all = Object.fromEntries(REQUIRED.map((k) => [k, true]));
  assert.equal(allowCheckout(all), true);
  for (const k of REQUIRED) for (const v of ["true", 1, {}, [], "yes"]) assert.equal(allowCheckout({ ...all, [k]: v }), false, k + "=" + JSON.stringify(v));
  assert.equal(allowCheckout(null), false);
  assert.equal(allowCheckout(undefined), false);
});

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
let tokenSeq = 0;
function tokenEnv() {
  tokenSeq += 1;
  return { MERCADOPAGO_ACCESS_TOKEN: "APP_USR-" + String(tokenSeq).padStart(4, "0") + "-".repeat(40), MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: sha("123456789").slice(0, 16) };
}
const meFetcher = (body, status = 200) => { const f = async () => { f.calls++; return new Response(JSON.stringify(body), { status }); }; f.calls = 0; return f; };
const goodMe = { id: 123456789, site_id: "MLB", tags: ["normal"] };

test("G2 token: conta certa abre; conta errada, test_user, site errado, HTTP != 200 e erro de rede fecham", async () => {
  assert.equal(await verifyProductionToken(tokenEnv(), { fetcher: meFetcher(goodMe), now: T0 }), true);
  for (const [name, body, status] of [["conta", { ...goodMe, id: 987 }, 200], ["test_user", { ...goodMe, tags: ["test_user"] }, 200], ["site", { ...goodMe, site_id: "MLA" }, 200], ["http", goodMe, 401], ["tags", { ...goodMe, tags: null }, 200]]) {
    assert.equal(await verifyProductionToken(tokenEnv(), { fetcher: meFetcher(body, status), now: T0 }), false, name);
  }
  const boom = async () => { throw new Error("network"); };
  assert.equal(await verifyProductionToken(tokenEnv(), { fetcher: boom, now: T0 }), false);
  const noNet = meFetcher(goodMe);
  assert.equal(await verifyProductionToken({ MERCADOPAGO_ACCESS_TOKEN: "TEST-" + "x".repeat(40), MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: sha("1").slice(0, 16) }, { fetcher: noNet, now: T0 }), false);
  assert.equal(await verifyProductionToken({ MERCADOPAGO_ACCESS_TOKEN: "APP_USR-" + "x".repeat(40), MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: "ZZ" }, { fetcher: noNet, now: T0 }), false);
  assert.equal(noNet.calls, 0, "formato inválido nunca chama a rede");
});

test("G2 cache do token: 119.999 ms reutiliza, exatamente 120.000 ms reverifica", async () => {
  const env = tokenEnv();
  const f = meFetcher(goodMe);
  assert.equal(await verifyProductionToken(env, { fetcher: f, now: T0 }), true);
  assert.equal(await verifyProductionToken(env, { fetcher: f, now: T0 + 119_999 }), true);
  assert.equal(f.calls, 1);
  const revoked = meFetcher(goodMe, 401);
  assert.equal(await verifyProductionToken(env, { fetcher: revoked, now: T0 + 120_000 }), false);
  assert.equal(revoked.calls, 1);
});

test("G2 cache do token: relógio voltando no tempo força reverificação (token revogado não fica válido)", async () => {
  const env = tokenEnv();
  assert.equal(await verifyProductionToken(env, { fetcher: meFetcher(goodMe), now: T0 }), true);
  const revoked = meFetcher(goodMe, 401);
  assert.equal(await verifyProductionToken(env, { fetcher: revoked, now: T0 - H }), false);
  assert.equal(revoked.calls, 1);
});

test("G2 rotas: matcher cobre variantes de caixa e não captura vizinhas; piloto de produção nega mutações", async () => {
  for (const p of ["/API/CHECKOUT", "/Checkout/", "/comprar", "/api/payments/checkout/x"]) assert.equal(isCheckoutRoute(p), true, p);
  for (const p of ["/checkouts", "/comprarx", "/api/checkoutx", "/x/checkout", "", null, undefined]) assert.equal(isCheckoutRoute(p), false, String(p));
  const prod = { MERCADOPAGO_ENV: "production" };
  assert.equal(await requiresPilotDenial(new Request("https://x/api/internal/certification/run", { method: "POST" }), prod), true);
  assert.equal(await requiresPilotDenial(new Request("https://x/api/internal/certification/run", { method: "GET" }), prod), false);
  assert.equal(await requiresPilotDenial(new Request("https://x/api/events/operator", { method: "POST", body: "{corrompido" }), prod), true, "corpo corrompido nega");
  assert.equal(await requiresPilotDenial(new Request("https://x/api/events/operator", { method: "POST", body: JSON.stringify({ name: "outro" }) }), prod), false);
  assert.equal(await requiresPilotDenial(new Request("https://x/api/internal/certification/run", { method: "POST" }), { ...prod, CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "true" }), false);
  assert.equal(await requiresPilotDenial(new Request("https://x/api/internal/certification/run", { method: "POST" }), { MERCADOPAGO_ENV: "sandbox" }), false);
});

// ---------------------------------------------------------------- G3 roteador de continuidade
// Tabela de decisão G3: transporte ⇔ scope_status ∈ {active,ready,enabled,operational};
// comercial ⇔ transporte ∧ release_gate e commercial_execution ambos ∈ {active,ready,enabled,operational};
// quorum_ok ⇔ nº de canais DISTINTOS com transporte >= minQuorum; HTTP 200 ⇔ quorum_ok, senão 503.
const up = { scope_status: "active", release_gate: "globally-blocked", commercial_execution: "blocked" };
const down = { scope_status: "down", release_gate: "globally-blocked", commercial_execution: "blocked" };
const live = { scope_status: "active", release_gate: "enabled", commercial_execution: "enabled" };

test("G3 quórum no limite: exatamente minQuorum → 200; minQuorum-1 → 503 degradado", async () => {
  const ok = continuityHttpResponse({ channel_readiness: { zevanory: up, email: up, instagram: up, whatsapp: down } }, { minQuorum: 3 });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.mode, "provider_independent");
  assert.equal(okBody.primary_channel, "zevanory");
  assert.deepEqual(okBody.fallback_channels, ["email", "instagram"]);
  const low = continuityHttpResponse({ channel_readiness: { zevanory: up, email: up, instagram: down } }, { minQuorum: 3 });
  assert.equal(low.status, 503);
  assert.equal((await low.json()).mode, "degraded_fail_closed");
  assert.equal(low.headers.get("cache-control"), "no-store");
});

test("G3 primária cai → próxima da prioridade assume; ordem não é invertida", () => {
  const a = buildContinuityPlan({ channel_readiness: { email: up, zevanory: up, instagram: up } }, { minQuorum: 1 });
  assert.equal(a.primary_channel, "zevanory");
  const b = buildContinuityPlan({ channel_readiness: { email: up, zevanory: down, instagram: up } }, { minQuorum: 1 });
  assert.equal(b.primary_channel, "email");
  assert.deepEqual(b.fallback_channels, ["instagram"]);
  const c = buildContinuityPlan({ channel_readiness: { a: up, b: up } }, { minQuorum: 1, priority: ["b", "a"] });
  assert.equal(c.primary_channel, "b");
  assert.deepEqual(c.fallback_channels, ["a"]);
});

test("G3 prioridade duplicada não infla o quórum", async () => {
  const plan = buildContinuityPlan({ channel_readiness: { zevanory: up } }, { minQuorum: 3, priority: ["zevanory", "zevanory", "zevanory"] });
  assert.equal(plan.quorum_ok, false);
  assert.deepEqual(plan.available_channels, ["zevanory"]);
  const r = continuityHttpResponse({ channel_readiness: { zevanory: up } }, { minQuorum: 3, priority: ["zevanory", "zevanory", "zevanory"] });
  assert.equal(r.status, 503);
});

test("G3 estado corrompido/ausente nunca conta como transporte saudável", () => {
  const plan = buildContinuityPlan({ channel_readiness: { a: null, b: 42, c: "active", d: { scope_status: " active" }, e: {}, f: { scope_status: ["active"] } } }, { minQuorum: 1 });
  assert.deepEqual(plan.available_channels, []);
  assert.equal(plan.quorum_ok, false);
  assert.equal(plan.primary_channel, null);
  for (const st of [undefined, null, {}, { channel_readiness: null }, { channel_readiness: "x" }]) {
    assert.equal(buildContinuityPlan(st, { minQuorum: 1 }).quorum_ok, false);
  }
});

test("G3 minQuorum inválido nunca relaxa para zero", () => {
  const st = { channel_readiness: {} };
  for (const q of [0, -5, "abc", NaN, null, undefined]) assert.equal(buildContinuityPlan(st, { minQuorum: q }).quorum_ok, false, String(q));
});

test("G3 comercial: só valores explícitos de liberação contam; ausente/desconhecido/not_applicable fecham", () => {
  const st = { channel_readiness: {
    ok: live,
    bloq: up,
    sem_gate: { scope_status: "active" },
    gate_lixo: { scope_status: "active", release_gate: "paused", commercial_execution: "enabled" },
    na: { scope_status: "active", release_gate: "enabled", commercial_execution: "not_applicable" },
    espaco: { scope_status: "active", release_gate: "blocked ", commercial_execution: "enabled" },
    caixa: { scope_status: "ACTIVE", release_gate: "Enabled", commercial_execution: "READY" }
  } };
  const plan = buildContinuityPlan(st, { minQuorum: 1 });
  assert.deepEqual([...plan.commercial_available_channels].sort(), ["caixa", "ok"]);
  assert.equal(plan.available_channels.length, 7, "transporte técnico continua independente do comercial");
});

// ---------------------------------------------------------------- G4 disjuntor de voz (rota A=azure, B=gemini)
// Tabela de decisão G4: A saudável → usa A e não toca B; A falha 1x → B atende, circuito de A fechado;
// A falha 2x → circuito aberto por 300.000 ms (A não é chamado); em openUntil-1 continua aberto;
// em openUntil exato fecha e A volta a ser tentado; failover desligado → nunca chama B;
// sem VOICE_TTS_FREE_ONLY → recusa sem rede; todos falham → erro explícito.
const voiceEnv = {
  VOICE_TTS_FREE_ONLY: "true", VOICE_TTS_FAILOVER_ENABLED: "true", VOICE_TTS_PROVIDER_CHAIN: "azure,gemini",
  AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "brazilsouth", AZURE_SPEECH_FREE_TIER_CONFIRMED: "true",
  GEMINI_API_KEY: "k", GEMINI_FREE_TIER_CONFIRMED: "true"
};
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
const resetBreaker = () => globalThis.__ZEVANORY_VOICE_BREAKER__?.clear?.();
function voiceFetch({ azure = "ok", gemini = "ok" } = {}) {
  const calls = [];
  const f = async (url) => {
    const u = String(url);
    if (u.includes("tts.speech.microsoft.com")) {
      calls.push("A");
      return azure === "ok" ? new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } }) : new Response("{}", { status: azure });
    }
    if (u.includes("generativelanguage.googleapis.com")) {
      calls.push("B");
      return gemini === "ok"
        ? Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/mpeg", data: Buffer.from(mp3).toString("base64") }] }] })
        : Response.json({ error: {} }, { status: gemini });
    }
    throw new Error("provedor_inesperado:" + u);
  };
  f.calls = calls;
  return f;
}
const voiceAt = (ms, env, f) => atClock(ms, () => ttsBytesWithFailover("Olá, teste B04.", env, f));
const azureState = (env = voiceEnv) => voiceProviderStatus(env).providers.find((p) => p.provider === "azure");

test("G4 rota A saudável atende e B não é tocada; A com 1 falha → B atende sem abrir o circuito", async () => {
  resetBreaker();
  const f = voiceFetch();
  assert.equal((await voiceAt(T0, voiceEnv, f)).provider, "azure");
  assert.deepEqual(f.calls, ["A"]);
  const g = voiceFetch({ azure: 503 });
  assert.equal((await voiceAt(T0 + 1, voiceEnv, g)).provider, "gemini");
  assert.deepEqual(g.calls, ["A", "B"]);
  await atClock(T0 + 1, () => { const s = azureState(); assert.equal(s.circuit_open, false); assert.equal(s.failures, 1); });
});

test("G4 sucesso de A zera o contador (falhas não consecutivas não abrem)", async () => {
  resetBreaker();
  await voiceAt(T0, voiceEnv, voiceFetch({ azure: 503 }));
  await voiceAt(T0 + 1, voiceEnv, voiceFetch());
  await voiceAt(T0 + 2, voiceEnv, voiceFetch({ azure: 503 }));
  await atClock(T0 + 2, () => assert.equal(azureState().circuit_open, false));
  const f = voiceFetch();
  await voiceAt(T0 + 3, voiceEnv, f);
  assert.deepEqual(f.calls, ["A"]);
});

test("G4 limite do cooldown: aberto em openUntil-1ms, fechado em openUntil exato", async () => {
  resetBreaker();
  await voiceAt(T0, voiceEnv, voiceFetch({ azure: 503 }));
  await voiceAt(T0, voiceEnv, voiceFetch({ azure: 503 }));
  await atClock(T0, () => assert.equal(azureState().circuit_open, true));
  const during = voiceFetch();
  assert.equal((await voiceAt(T0 + 300_000 - 1, voiceEnv, during)).provider, "gemini");
  assert.deepEqual(during.calls, ["B"], "circuito aberto não chama a rota A");
  const after = voiceFetch();
  assert.equal((await voiceAt(T0 + 300_000, voiceEnv, after)).provider, "azure");
  assert.deepEqual(after.calls, ["A"]);
});

test("G4 após o cooldown exato o contador zera: uma falha isolada de A não reabre o circuito", async () => {
  resetBreaker();
  await voiceAt(T0, voiceEnv, voiceFetch({ azure: 503 }));
  await voiceAt(T0, voiceEnv, voiceFetch({ azure: 503 }));
  const retry = voiceFetch({ azure: 503 });
  assert.equal((await voiceAt(T0 + 300_000, voiceEnv, retry)).provider, "gemini");
  assert.deepEqual(retry.calls, ["A", "B"]);
  await atClock(T0 + 300_000, () => { const s = azureState(); assert.equal(s.failures, 1); assert.equal(s.circuit_open, false); });
  const next = voiceFetch();
  assert.equal((await voiceAt(T0 + 300_001, voiceEnv, next)).provider, "azure", "rota A saudável não pode ficar fechada (FALSE_DENY)");
  assert.deepEqual(next.calls, ["A"]);
});

test("G4 failover desligado: falha de A não transfere para B", async () => {
  resetBreaker();
  const f = voiceFetch({ azure: 503 });
  await assert.rejects(() => voiceAt(T0, { ...voiceEnv, VOICE_TTS_FAILOVER_ENABLED: "false" }, f), /voice_tts_all_providers_failed/);
  assert.deepEqual(f.calls, ["A"]);
});

test("G4 ambas as rotas caídas → erro explícito; sem guarda zero-custo → recusa sem rede", async () => {
  resetBreaker();
  const f = voiceFetch({ azure: 503, gemini: 503 });
  await assert.rejects(() => voiceAt(T0, voiceEnv, f), /voice_tts_all_providers_failed/);
  assert.ok(f.calls.includes("A") && f.calls.includes("B"));
  resetBreaker();
  const g = voiceFetch();
  await assert.rejects(() => voiceAt(T0, { ...voiceEnv, VOICE_TTS_FREE_ONLY: "false" }, g), /voice_tts_zero_spend_guard_required/);
  assert.deepEqual(g.calls, []);
});

test("G4 rota A sem confirmação de camada gratuita é excluída (nunca é chamada)", async () => {
  resetBreaker();
  const f = voiceFetch();
  const env = { ...voiceEnv, AZURE_SPEECH_FREE_TIER_CONFIRMED: "TRUE " };
  assert.equal((await voiceAt(T0, env, f)).provider, "gemini");
  assert.deepEqual(f.calls, ["B"]);
});

// ---------------------------------------------------------------- G5 prontidão (classificação, não autorização)
test("G5 prontidão fechada-segura: par positivo e cada sinal isolado nega", () => {
  const env = { ABSOLUTE_RELEASE_APPROVED: "true", MERCADOPAGO_ENV: "production", PAYMENT_PROVIDER: "mercadopago" };
  const sw = { SALE_GLOBALLY_ENABLED: false, PRE_SALE_GATES_APPROVED: true, CHECKOUT_ENABLED: true, FINANCIAL_EVENTS_ENABLED: true, WHATSAPP_SALES_ENABLED: false };
  assert.equal(safeClosedCommercialStaging(env, false, sw), true);
  assert.equal(safeClosedCommercialStaging(env, true, sw), false, "vendas abertas não é staging fechado");
  assert.equal(safeClosedCommercialStaging(env, false, { ...sw, SALE_GLOBALLY_ENABLED: true }), false);
  assert.equal(safeClosedCommercialStaging(env, false, { ...sw, WHATSAPP_SALES_ENABLED: "false" }), false);
  assert.equal(safeClosedCommercialStaging({ ...env, PAYMENT_PROVIDER: "stripe" }, false, sw), false);
  assert.equal(safeClosedCommercialStaging({ ...env, MERCADOPAGO_ENV: "sandbox" }, false, sw), false);
  assert.equal(safeClosedCommercialStaging(undefined, false, {}), false);
});
