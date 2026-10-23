// B05/B08 — failover MP -> Asaas, boleto Asaas e webhook Asaas endurecido, pelo BUNDLE REAL de produção
// (worker/cloudflare-worker.recovered.mjs: rotas /api/checkout/auto, /api/checkout/asaas, /api/webhooks/asaas/<segredo>,
// /api/payments/continuity) contra PostgreSQL EFÊMERO real. Mercado Pago e Asaas são FALSOS locais: nenhuma chamada
// sai da máquina; qualquer host não simulado é bloqueado. Sem credenciais reais, sem dinheiro.
// Run: T4_PG_HOST=... T4_PG_PORT=... node --import ./tests/t4_sim/register.mjs --test tests/integration/psp-checkout-postgres.test.mjs
import { test as nodeTest, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SKIP, psqlRaw, rowsSync, neonResponse } from "./psp-pg.mjs";

const realFetch = globalThis.fetch;
// Meta-testes do runner de mutantes (scripts/ci/mutants_psp.py): T4_INJECT_TYPEERROR=<prefixo> lança TypeError
// (falha SEM asserção) no teste com esse prefixo; T4_INJECT_ECONNRESET=1 derruba a 1ª chamada ao MP com um
// ECONNRESET real de transporte. Sem as variáveis, nada muda.
const test = (name, opts, fn) => nodeTest(name, opts, async (...a) => {
  if (process.env.T4_INJECT_TYPEERROR && name.startsWith(process.env.T4_INJECT_TYPEERROR)) { console.log("T4_INJECTED_TYPEERROR"); const o = null; o.boom(); }
  return fn(...a);
});
let injectedReset = false;
const PATH_SECRET = "p".repeat(24) + "Q_" + "r".repeat(22);
const HOOK_TOKEN = "w".repeat(40) + "Z9";
const BASE = "http://127.0.0.1:8788";

// ---------- mundo falso ----------
const world = {
  emails: [], resendFail: 0, sqlDelayMs: 0,
  mp: { mode: "ok", calls: [], createdServerSide: 0, delayMs: 0, hold: null },
  asaas: { checkoutMode: "ok", paymentMode: "ok", calls: [], payments: new Map(), customers: [] },
};
const kvStore = new Map();
let kvFault = () => false; // injeção de falha de leitura do KV (Sol AVAL 083)
const kv = { async get(k) { if (kvFault(k)) throw new Error("synthetic kv read outage"); return kvStore.get(k) ?? null; }, async put(k, v) { kvStore.set(k, String(v)); }, async delete(k) { kvStore.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } };
const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const hang = (init) => new Promise((_, reject) => {
  const s = init.signal;
  if (!s) return; // sem timeout o request ficaria preso para sempre: o teste falharia por tempo (e o mutante morre)
  if (s.aborted) return reject(s.reason);
  s.addEventListener("abort", () => reject(s.reason), { once: true });
});
let seqPay = 0;

function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.pathname === "/sql" && init.headers?.["Neon-Connection-String"]) return world.sqlDelayMs ? new Promise((r) => setTimeout(r, world.sqlDelayMs)).then(() => neonResponse(init)) : Promise.resolve(neonResponse(init));
  const method = String(init.method || "GET").toUpperCase();
  if (url.hostname === "api.mercadopago.com") {
    if (process.env.T4_INJECT_ECONNRESET === "1" && !injectedReset) {
      injectedReset = true;
      console.log("T4_INJECTED_ECONNRESET");
      return Promise.reject(Object.assign(new Error("T4_INJECTED_ECONNRESET read ECONNRESET"), { code: "ECONNRESET" }));
    }
    const body = init.body ? JSON.parse(init.body) : null;
    world.mp.calls.push({ method, path: url.pathname, idem: init.headers?.["x-idempotency-key"] || "", ref: body?.external_reference || "", hasSignal: Boolean(init.signal), signal: init.signal || null, at: Date.now() });
    if (method === "POST" && url.pathname === "/checkout/preferences") {
      if (world.mp.mode === "timeout") { world.mp.createdServerSide++; return hang(init); } // o MP CRIOU e a resposta nunca chegou
      if (world.mp.mode === "slow_tail") { world.mp.inflight = (world.mp.inflight || 0) + 1; return hang(init).finally(() => { world.mp.inflight -= 1; world.mp.abortedAt = Date.now(); }); }
      if (world.mp.mode === "5xx") return json(503, { message: "service unavailable" });
      if (world.mp.hold) { const h = world.mp.hold; world.mp.hold = null; return h.then(() => json(201, { id: `pref-held-${world.mp.calls.length}`, external_reference: body.external_reference, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=held${world.mp.calls.length}` })); }
      if (world.mp.delayMs) return new Promise((r) => setTimeout(r, world.mp.delayMs)).then(() => json(201, { id: `pref-${world.mp.calls.length}`, external_reference: body.external_reference, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${world.mp.calls.length}` }));
      return json(201, { id: `pref-${world.mp.calls.length}`, external_reference: body.external_reference, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${world.mp.calls.length}` });
    }
    return Promise.reject(new Error("T4: unexpected MP call " + url.pathname));
  }
  if (url.hostname === "api.asaas.com") {
    const body = init.body ? JSON.parse(init.body) : null;
    world.asaas.calls.push({ method, path: url.pathname, search: url.search, body, hasSignal: Boolean(init.signal) });
    if (method === "POST" && url.pathname === "/v3/checkouts") {
      if (world.asaas.checkoutMode === "5xx") return json(502, { errors: [{ code: "bad_gateway" }] });
      if (world.asaas.checkoutMode === "timeout") return hang(init);
      const id = randomUUID();
      return json(200, { id, link: `https://asaas.com/checkoutSession/show?id=${id}`, externalReference: body.externalReference });
    }
    if (method === "GET" && url.pathname === "/v3/payments") {
      const ref = url.searchParams.get("externalReference");
      return json(200, { object: "list", hasMore: false, data: [...world.asaas.payments.values()].filter((p) => p.externalReference === ref) });
    }
    if (method === "GET" && url.pathname === "/v3/customers") {
      return json(200, { object: "list", data: world.asaas.customers.filter((c) => c.cpfCnpj === url.searchParams.get("cpfCnpj")) });
    }
    if (method === "POST" && url.pathname === "/v3/customers") {
      const c = { id: `cus_t4${world.asaas.customers.length + 1}abc`, cpfCnpj: body.cpfCnpj, name: body.name };
      world.asaas.customers.push(c);
      return json(200, c);
    }
    if (method === "POST" && url.pathname === "/v3/payments") {
      const id = `pay_t4b${String(++seqPay).padStart(6, "0")}`;
      const p = { id, customer: body.customer, billingType: body.billingType, value: body.value, dueDate: body.dueDate, externalReference: body.externalReference, status: "PENDING",
        bankSlipUrl: `https://www.asaas.com/b/pdf/${id}`, invoiceUrl: `https://www.asaas.com/i/${id}` };
      if (world.asaas.paymentMode === "timeout_after_create") { world.asaas.payments.set(id, p); return hang(init); }
      if (world.asaas.paymentMode === "timeout_before_create") return hang(init);
      world.asaas.payments.set(id, p);
      return json(200, p);
    }
    const m = url.pathname.match(/^\/v3\/payments\/(pay_[A-Za-z0-9_-]+)$/);
    if (method === "GET" && m) {
      const p = world.asaas.payments.get(m[1]);
      return p ? json(200, p) : json(404, {});
    }
    return Promise.reject(new Error("T4: unexpected Asaas call " + method + " " + url.pathname));
  }
  if (url.hostname === "api.resend.com" && method === "POST") {
    const b = JSON.parse(init.body);
    if (world.resendFail > 0) { world.resendFail -= 1; world.emailFailures = (world.emailFailures || 0) + 1; return json(500, { name: "internal_server_error" }); }
    world.emails.push({ to: b.to, subject: b.subject, text: b.text, idem: init.headers?.["idempotency-key"] || "" });
    return json(200, { id: "sim-" + world.emails.length });
  }
  return Promise.reject(new Error("T4: unexpected external call blocked: " + url.hostname));
}

// ---------- helpers ----------
const ENV = {
  DATABASE_URL: "postgresql://sim:sim@ep-t4-sim.local/neondb", FINANCIAL_EVENTS_ENABLED: "true", CHECKOUT_ENABLED: "true",
  SALE_GLOBALLY_ENABLED: "true", PAYMENT_PUBLIC_BASE_URL: "https://zevanory.api.br", PAYMENT_PROVIDER_POOL: "mercadopago,asaas",
  MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: "APP_USR-synthetic", MERCADOPAGO_WEBHOOK_SECRET: "t4-synthetic",
  ASAAS_ENV: "production", ASAAS_API_KEY: "synthetic-asaas-key", ASAAS_WEBHOOK_TOKEN: HOOK_TOKEN, ASAAS_WEBHOOK_PATH_SECRET: PATH_SECRET,
  ASAAS_BOLETO_ENABLED: "true", PSP_PROVIDER_TIMEOUT_MS: "1000", RESEND_API_KEY: "",
};
const checkout = async (body = {}, { path = "/api/checkout/auto" } = {}) => {
  const res = await realFetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: randomUUID(), session_id: randomUUID(), offer_id: "ZEV-IA-011", ...body }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const hook = async (body, { secret = PATH_SECRET, token = HOOK_TOKEN, path } = {}) => {
  const res = await realFetch(BASE + (path ?? `/api/webhooks/asaas/${secret}`), { method: "POST", headers: { "content-type": "application/json", ...(token ? { "asaas-access-token": token } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const order = (id) => rowsSync("select order_id, provider, status, provider_checkout_id, checkout_url, external_reference, amount from orders where order_id=$1", [id])[0];
const ordersByRequest = (rid) => rowsSync("select order_id, provider, status from orders where request_id=$1", [rid]);
const countEvents = (id) => Number(rowsSync("select count(*)::int as n from financial_events where order_id=$1", [id])[0].n);
const mpPrefCalls = () => world.mp.calls.filter((c) => c.path === "/checkout/preferences").length;
const asaasCalls = (method, path) => world.asaas.calls.filter((c) => c.method === method && c.path === path).length;
const payer = { name: "Comprador Sintético", cpf_cnpj: "529.982.247-25", email: "comprador.sintetico@example.com" };

before(async () => {
  if (SKIP) return;
  psqlRaw("drop table if exists asaas_refund_intents cascade;\n");
  psqlRaw(readFileSync(new URL("../t4_sim/schema.sql", import.meta.url), "utf8"));
  // Colunas/índice que o checkout real usa e o esquema T4 (só do webhook) não tinha.
  psqlRaw("alter table orders add column if not exists checkout_url text; create unique index if not exists orders_request_id_uq on orders(request_id);\n");
  psqlRaw("drop table if exists psp_circuit_probes;\n");
  psqlRaw(readFileSync(new URL("../../db/b05/psp_circuit_probes.sql", import.meta.url), "utf8"));
  psqlRaw("drop table if exists asaas_dlq_alerts;\n");
  psqlRaw(readFileSync(new URL("../../db/b05/asaas_dlq_alerts.sql", import.meta.url), "utf8"));
  Object.assign(process.env, ENV);
  globalThis.__ZEVANORY_PRIVATE_KV__ = kv;
  globalThis.fetch = fakeFetch;
  await import("../../worker/cloudflare-worker.recovered.mjs");
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/api/health"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.PSP_FORCE_DOWN;
  for (const k of [...kvStore.keys()]) if (k.startsWith("psp:")) kvStore.delete(k);
  world.mp.mode = "ok"; world.mp.delayMs = 0; world.sqlDelayMs = 0; world.resendFail = 0; delete globalThis.__ZEVANORY_PSP_PROBE_TIMING__; world.asaas.checkoutMode = "ok"; world.asaas.paymentMode = "ok";
  kvFault = () => false;
});
after(() => { if (!SKIP) setTimeout(() => process.exit(process.exitCode || 0), 50); });

// ---------- failover ----------
test("C1 dois saudáveis: só o Mercado Pago é chamado, com chave de idempotência do pedido e timeout", { skip: SKIP }, async () => {
  const mp0 = mpPrefCalls(), as0 = asaasCalls("POST", "/v3/checkouts");
  const out = await checkout();
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.provider, "mercadopago");
  assert.equal(out.body.failover, false);
  assert.equal(mpPrefCalls() - mp0, 1);
  assert.equal(asaasCalls("POST", "/v3/checkouts") - as0, 0, "Asaas não pode ser chamado com o MP saudável");
  const last = world.mp.calls.at(-1);
  assert.equal(last.idem, `zevanory-order-${out.body.order_id}`);
  assert.equal(last.hasSignal, true, "chamada ao provedor sempre com timeout");
  assert.equal(order(out.body.order_id).provider, "mercadopago");
});

test("C2 MP timeout NO MEIO da requisição (ambíguo): sem segunda cobrança no Asaas, pedido incerto, reenvio também não cobra", { skip: SKIP }, async () => {
  world.mp.mode = "timeout";
  const rid = randomUUID(), sid = randomUUID();
  const mp0 = mpPrefCalls(), as0 = world.asaas.calls.length, created0 = world.mp.createdServerSide;
  const out = await checkout({ request_id: rid, session_id: sid });
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "checkout_provider_uncertain");
  assert.equal(out.body.fallback_suppressed, true);
  assert.equal(out.body.reconciliation_required, true);
  assert.deepEqual(out.body.providers_called, ["mercadopago"]);
  assert.equal(world.mp.createdServerSide - created0, 1, "o MP chegou a criar a preferência");
  assert.equal(world.asaas.calls.length - as0, 0, "NENHUMA chamada ao Asaas depois de resultado ambíguo");
  const rows = ordersByRequest(rid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "checkout_uncertain");
  // Cliente reenvia o MESMO pedido (MP voltou ou não): nada de nova cobrança em nenhum provedor.
  world.mp.mode = "ok";
  const again = await checkout({ request_id: rid, session_id: sid });
  assert.notEqual(again.status, 201, JSON.stringify(again.body));
  assert.equal(mpPrefCalls() - mp0, 1, "nenhuma segunda preferência MP");
  assert.equal(world.asaas.calls.length - as0, 0, "nenhuma cobrança Asaas");
  assert.equal(ordersByRequest(rid).length, 1);
});

test("C3 MP fora (5xx): disjuntor abre após 3 falhas e o próximo pedido vai ao Asaas sem tocar no MP", { skip: SKIP }, async () => {
  world.mp.mode = "5xx";
  for (let i = 0; i < 3; i++) {
    const r = await checkout();
    assert.equal(r.body.provider, "mercadopago");
    assert.equal(r.body.fallback_suppressed, true, "5xx na criação também é ambíguo: sem failover no mesmo pedido");
  }
  const mp0 = mpPrefCalls(), as0 = asaasCalls("POST", "/v3/checkouts");
  const out = await checkout();
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.provider, "asaas");
  assert.equal(out.body.failover, true);
  assert.deepEqual(out.body.providers_called, ["asaas"]);
  assert.equal(mpPrefCalls() - mp0, 0, "MP com disjuntor aberto não é chamado");
  assert.equal(asaasCalls("POST", "/v3/checkouts") - as0, 1);
  const o = order(out.body.order_id);
  assert.equal(o.provider, "asaas");
  assert.equal(o.status, "checkout_ready");
  assert.match(o.checkout_url, /^https:\/\/asaas\.com\/checkoutSession\//);
  const plan = await (await realFetch(BASE + "/api/payments/continuity")).json();
  assert.equal(plan.circuits.mercadopago, "open");
  assert.equal(plan.mode, "degraded");
  assert.doesNotMatch(JSON.stringify(plan), /synthetic|APP_USR|ppppp|wwww/);
});

test("C4 os dois fora: 503 fail-closed sem chamar nenhum provedor", { skip: SKIP }, async () => {
  world.mp.mode = "5xx"; world.asaas.checkoutMode = "5xx";
  for (let i = 0; i < 3; i++) await checkout();            // abre o MP
  for (let i = 0; i < 3; i++) assert.equal((await checkout()).body.provider, "asaas"); // abre o Asaas
  const n0 = world.mp.calls.length + world.asaas.calls.length;
  const out = await checkout();
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "payment_capacity_unavailable");
  assert.equal(out.body.fail_closed, true);
  assert.equal(world.mp.calls.length + world.asaas.calls.length - n0, 0);
  const res = await realFetch(BASE + "/api/payments/continuity");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).mode, "fail_closed");
});

test("C5 trava comercial fechada bloqueia OS DOIS provedores (auto, MP aberto/fechado, rota Asaas explícita e boleto)", { skip: SKIP }, async () => {
  process.env.SALE_GLOBALLY_ENABLED = "false";
  const n0 = world.mp.calls.length + world.asaas.calls.length;
  const before = Number(rowsSync("select count(*)::int as n from orders")[0].n);
  const a = await checkout();
  assert.equal(a.status, 503);
  assert.equal(a.body.error, "sales_globally_blocked");
  for (let i = 0; i < 3; i++) await kv.put("psp:health:v1:mercadopago", JSON.stringify({ status: "down" }));
  const b = await checkout();
  assert.equal(b.body.error, "sales_globally_blocked", "com o MP fora o failover NÃO reabre vendas no Asaas");
  const c = await checkout({}, { path: "/api/checkout/asaas" });
  assert.equal(c.status, 503);
  assert.equal(c.body.error, "sales_globally_blocked");
  const d = await checkout({ payment_method: "boleto", payer });
  assert.equal(d.body.error, "sales_globally_blocked");
  assert.equal(world.mp.calls.length + world.asaas.calls.length - n0, 0, "nenhum provedor chamado");
  assert.equal(Number(rowsSync("select count(*)::int as n from orders")[0].n), before, "nenhum pedido gravado");
});

test("C6 saúde explícita: PSP_FORCE_DOWN=mercadopago leva direto ao Asaas", { skip: SKIP }, async () => {
  process.env.PSP_FORCE_DOWN = "mercadopago";
  const mp0 = mpPrefCalls();
  const out = await checkout();
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.provider, "asaas");
  assert.equal(mpPrefCalls() - mp0, 0);
});

test("C7 seleção de provedor sem hash: a ordem fixa não depende da chave da operação", { skip: SKIP }, async () => {
  const { selectPaymentProvider } = await import("../../worker/cloudflare-worker.recovered.mjs");
  for (const key of ["a", "zzzz", "order-1", "b"]) {
    const s = selectPaymentProvider(process.env, { production: true, operationKey: key });
    assert.equal(s.provider, "mercadopago", `chave ${key}`);
    assert.equal(s.reason, "deterministic_fallback_order");
  }
  process.env.PSP_FORCE_DOWN = "";
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  assert.equal(selectPaymentProvider(process.env, { production: true, operationKey: "zzzz" }).provider, "asaas", "MP sem credencial => Asaas");
});

test("C8 meia-abertura: com a sondagem ao MP EM VOO, os pedidos seguintes não tocam o MP (vão ao Asaas); depois o disjuntor fecha", { skip: SKIP }, async () => {
  psqlRaw("delete from psp_circuit_probes;\n");
  await kv.put("psp:circuit:v1:mercadopago", JSON.stringify({ failures: [], opened_at: Date.now() - 121_000 })); // resfriamento (120 s) vencido
  let release;
  world.mp.hold = new Promise((r) => { release = r; }); // só a 1ª chamada ao MP (a sondagem) fica presa até o teste soltar; as outras respondem já
  const mp0 = mpPrefCalls();
  try {
    const probe = checkout();
    for (let i = 0; i < 50 && mpPrefCalls() === mp0; i++) await new Promise((r) => setTimeout(r, 50)); // sondagem chegou ao MP
    assert.equal(mpPrefCalls() - mp0, 1, "sondagem em voo");
    const others = [];
    for (let i = 0; i < 3; i++) others.push(await checkout());
    assert.ok(others.every((o) => o.status === 201 && o.body.provider === "asaas"), JSON.stringify(others.map((o) => o.body)));
    assert.equal(mpPrefCalls() - mp0, 1, "nenhuma segunda chamada ao MP enquanto a sondagem está em voo");
    const concurrent = await Promise.all([checkout(), checkout()]);
    assert.ok(concurrent.every((o) => o.body.provider === "asaas"), JSON.stringify(concurrent.map((o) => o.body)));
    assert.equal(rowsSync("select count(*)::int as n from psp_circuit_probes where provider='mercadopago' and lease_until > now()")[0].n, "1");
    release();
    const p = await probe;
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.provider, "mercadopago");
    assert.equal(mpPrefCalls() - mp0, 1);
  } finally {
    release?.();
    world.mp.hold = null;
  }
  const plan = await (await realFetch(BASE + "/api/payments/continuity")).json();
  assert.equal(plan.circuits.mercadopago, "closed", "sondagem bem-sucedida fecha o disjuntor");
});

test("C9 falha de leitura do KV do disjuntor do Asaas com o MP fora: fallback NÃO é aberto às cegas (503, Asaas não chamado)", { skip: SKIP }, async () => {
  process.env.PSP_FORCE_DOWN = "mercadopago";
  kvFault = (k) => k === "psp:circuit:v1:asaas";
  const as0 = world.asaas.calls.length;
  const out = await checkout();
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "payment_capacity_unavailable");
  assert.deepEqual(out.body.skipped.map((x) => x.reason), ["forced_down", "unknown_fallback_not_opened"]);
  assert.equal(world.asaas.calls.length - as0, 0);
  kvFault = () => false;
  delete process.env.PSP_FORCE_DOWN;
});

// ---------- boleto ----------
test("B1 boleto: cliente + cobrança BOLETO no Asaas, MP nunca chamado, reenvio reaproveita a MESMA cobrança", { skip: SKIP }, async () => {
  const rid = randomUUID(), sid = randomUUID();
  const mp0 = mpPrefCalls(), pay0 = asaasCalls("POST", "/v3/payments");
  const out = await checkout({ request_id: rid, session_id: sid, payment_method: "boleto", payer });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.payment_method, "boleto");
  assert.equal(out.body.provider, "asaas");
  assert.match(out.body.checkout_url, /^https:\/\/www\.asaas\.com\/b\/pdf\/pay_/);
  assert.equal(mpPrefCalls() - mp0, 0);
  assert.equal(asaasCalls("POST", "/v3/payments") - pay0, 1);
  const sent = world.asaas.calls.filter((c) => c.method === "POST" && c.path === "/v3/payments").at(-1).body;
  assert.equal(sent.billingType, "BOLETO");
  assert.equal(sent.value, 197);
  const o = order(out.body.order_id);
  assert.equal(sent.externalReference, o.external_reference);
  assert.equal(o.provider, "asaas");
  assert.equal(o.status, "checkout_ready");
  const again = await checkout({ request_id: rid, session_id: sid, payment_method: "boleto", payer });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(asaasCalls("POST", "/v3/payments") - pay0, 1, "nenhum segundo boleto");
});

test("B2 boleto: timeout DEPOIS de o Asaas criar => reconcilia pela externalReference e devolve a cobrança existente (uma só)", { skip: SKIP }, async () => {
  world.asaas.paymentMode = "timeout_after_create";
  const pay0 = asaasCalls("POST", "/v3/payments");
  const out = await checkout({ payment_method: "boleto", payer });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.reconciled_existing, true);
  assert.equal(asaasCalls("POST", "/v3/payments") - pay0, 1);
  const o = order(out.body.order_id);
  assert.equal([...world.asaas.payments.values()].filter((p) => p.externalReference === o.external_reference).length, 1);
});

test("B3 boleto: timeout SEM cobrança encontrada => pedido incerto, 503, e reenvio não cria segundo boleto", { skip: SKIP }, async () => {
  world.asaas.paymentMode = "timeout_before_create";
  const rid = randomUUID(), sid = randomUUID();
  const pay0 = asaasCalls("POST", "/v3/payments");
  const out = await checkout({ request_id: rid, session_id: sid, payment_method: "boleto", payer });
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "checkout_provider_uncertain");
  assert.equal(out.body.reconciliation_required, true);
  assert.equal(ordersByRequest(rid)[0].status, "checkout_uncertain");
  world.asaas.paymentMode = "ok";
  const again = await checkout({ request_id: rid, session_id: sid, payment_method: "boleto", payer });
  assert.notEqual(again.status, 201);
  assert.equal(asaasCalls("POST", "/v3/payments") - pay0, 1, "só a tentativa original");
});

test("B4 boleto: pagador inválido ou boleto desligado => 400 sem chamar provedor", { skip: SKIP }, async () => {
  const n0 = world.asaas.calls.length;
  assert.equal((await checkout({ payment_method: "boleto", payer: { ...payer, cpf_cnpj: "111.111.111-11" } })).status, 400);
  process.env.ASAAS_BOLETO_ENABLED = "false";
  assert.equal((await checkout({ payment_method: "boleto", payer })).body.error, "boleto_disabled");
  assert.equal(world.asaas.calls.length - n0, 0);
});

// ---------- webhook ----------
async function asaasPaidSetup() {
  const out = await checkout({ payment_method: "boleto", payer });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const o = order(out.body.order_id);
  const p = world.asaas.payments.get(o.provider_checkout_id);
  return { o, p };
}
const evt = (event, paymentId, id = `evt_${randomUUID().replace(/-/g, "")}`) => ({ id, event, payment: { id: paymentId } });

test("W1 autenticação: caminho sem segredo/segredo errado => 404; token errado/ausente => 401; nada consultado", { skip: SKIP }, async () => {
  const { p } = await asaasPaidSetup();
  p.status = "RECEIVED";
  const get0 = world.asaas.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v3/payments/")).length;
  assert.equal((await hook(evt("PAYMENT_RECEIVED", p.id), { path: "/api/webhooks/asaas" })).status, 404, "rota antiga sem segredo");
  assert.equal((await hook(evt("PAYMENT_RECEIVED", p.id), { secret: PATH_SECRET.slice(0, -1) + "x" })).status, 404);
  assert.equal((await hook(evt("PAYMENT_RECEIVED", p.id), { token: HOOK_TOKEN.slice(0, -1) + "x" })).status, 401);
  assert.equal((await hook(evt("PAYMENT_RECEIVED", p.id), { token: "" })).status, 401);
  assert.equal(world.asaas.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v3/payments/")).length - get0, 0);
});

test("W2 corpo forjado: a verdade vem do GET no Asaas (pagamento pendente/valor/referência divergentes) => nunca pago", { skip: SKIP }, async () => {
  const { o, p } = await asaasPaidSetup();
  // Corpo forjado COMPLETO e coerente (recebido, valor e referência certos); o Asaas, re-consultado, diz PENDING.
  const forged = { ...evt("PAYMENT_RECEIVED", p.id), payment: { ...p, status: "RECEIVED" } };
  const r1 = await hook(forged);
  assert.equal(r1.status, 409, JSON.stringify(r1.body));
  assert.notEqual(order(o.order_id).status, "paid", "corpo forjado não marca pago");
  p.status = "RECEIVED"; p.value = 1.97;
  assert.equal((await hook(evt("PAYMENT_RECEIVED", p.id))).status, 409, "valor divergente");
  p.value = 197; p.externalReference = "ZEVANORY:EXP-0001:" + randomUUID();
  const r3 = await hook(evt("PAYMENT_RECEIVED", p.id));
  assert.equal(r3.body.reason, "unlinked_payment", "referência de outro pedido não liga a este");
  assert.notEqual(order(o.order_id).status, "paid");
  assert.equal(countEvents(o.order_id), 0);
});

test("W3 confirmação legítima e duplicata: pago uma vez, um evento, duplicata nem re-consulta o Asaas", { skip: SKIP }, async () => {
  const { o, p } = await asaasPaidSetup();
  p.status = "RECEIVED";
  const e = evt("PAYMENT_RECEIVED", p.id);
  const r1 = await hook(e);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(order(o.order_id).status, "paid");
  const get0 = world.asaas.calls.filter((c) => c.method === "GET" && c.path === `/v3/payments/${p.id}`).length;
  const r2 = await hook(e);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true);
  assert.equal(world.asaas.calls.filter((c) => c.method === "GET" && c.path === `/v3/payments/${p.id}`).length - get0, 0, "dedupe antes da re-consulta");
  // KV perdido/expirado (dedupe rápido indisponível): a reentrega chega ao banco e o ON CONFLICT segura.
  kvStore.delete("asaas:webhook:done:v1:" + e.id);
  const r3 = await hook(e);
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  assert.equal(r3.body.duplicate, true);
  assert.equal(world.asaas.calls.filter((c) => c.method === "GET" && c.path === `/v3/payments/${p.id}`).length - get0, 1, "sem KV, re-consulta o Asaas");
  assert.equal(countEvents(o.order_id), 1);
});

test("W4 fora de ordem: estorno antes da confirmação => aceito sem efeito e para reconciliação; confirmação posterior nunca paga", { skip: SKIP }, async () => {
  const { o, p } = await asaasPaidSetup();
  p.status = "REFUNDED"; p.refunds = [{ status: "DONE", value: 197 }];
  const r1 = await hook(evt("PAYMENT_REFUNDED", p.id));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.reason, "refund_before_payment_recorded");
  assert.equal(r1.body.reconciliation_required, true);
  assert.ok([...kvStore.keys()].some((k) => k.startsWith("asaas:webhook:review:v1:")), "caso enfileirado para revisão");
  const r2 = await hook(evt("PAYMENT_RECEIVED", p.id));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.reason, "superseded_payment_event");
  assert.notEqual(order(o.order_id).status, "paid");
  assert.equal(countEvents(o.order_id), 0);
});

test("W5 evento autenticado não tratado => 200 ignorado (a fila do Asaas não pausa); corpo inválido => 400", { skip: SKIP }, async () => {
  const r = await hook({ id: "evt_t4unhandled01", event: "PAYMENT_CREATED", payment: { id: "pay_t4unhandled" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, true);
  assert.equal((await hook({ id: "nope", event: "PAYMENT_RECEIVED" })).status, 400);
});

const clearReview = () => { for (const k of [...kvStore.keys()]) if (k.startsWith("asaas:webhook:review:v1:") || k.startsWith("asaas:webhook:dlq:v1:") || k.startsWith("asaas:webhook:dlq-alert:v1:")) kvStore.delete(k); };

test("W6 estorno parcial antes da confirmação: fica na fila; a confirmação paga; o watchdog DRENA e aplica o estorno (uma vez)", { skip: SKIP }, async () => {
  clearReview();
  const { o, p } = await asaasPaidSetup();
  p.status = "RECEIVED"; p.refunds = [{ status: "DONE", value: 50 }];
  const early = evt("PAYMENT_PARTIALLY_REFUNDED", p.id);
  const r1 = await hook(early);
  assert.equal(r1.body.reason, "refund_before_payment_recorded", JSON.stringify(r1.body));
  assert.ok(kvStore.has("asaas:webhook:review:v1:" + early.id));
  assert.equal(kvStore.has("asaas:webhook:done:v1:" + early.id), false, "evento antecipado não é marcado como processado");
  const r2 = await hook(evt("PAYMENT_RECEIVED", p.id));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(order(o.order_id).status, "paid");
  const { runPaidDeliveryWatchdog } = await import("../../worker/cloudflare-worker.recovered.mjs");
  const wd = await runPaidDeliveryWatchdog(process.env);
  assert.equal(wd.asaas_review.resolved, 1, JSON.stringify(wd));
  assert.equal(order(o.order_id).status, "partially_refunded");
  assert.equal(countEvents(o.order_id), 2);
  assert.equal(kvStore.has("asaas:webhook:review:v1:" + early.id), false, "item drenado");
  const again = await runPaidDeliveryWatchdog(process.env);
  assert.equal(again.asaas_review.checked, 0);
  assert.equal(countEvents(o.order_id), 2, "idempotente");
});

test("W7 estorno total antes da confirmação (nunca pago): tentativas esgotam => DLQ + UM e-mail ao proprietário; nada é pago", { skip: SKIP }, async () => {
  clearReview();
  process.env.RESEND_API_KEY = "re_synthetic";
  const { o, p } = await asaasPaidSetup();
  p.status = "REFUNDED"; p.refunds = [{ status: "DONE", value: 197 }];
  const early = evt("PAYMENT_REFUNDED", p.id);
  assert.equal((await hook(early)).body.reason, "refund_before_payment_recorded");
  assert.equal((await hook(evt("PAYMENT_RECEIVED", p.id))).body.reason, "superseded_payment_event");
  const { drainAsaasReviewQueue } = await import("../../worker/cloudflare-worker.recovered.mjs");
  const e0 = world.emails.length;
  const d1 = await drainAsaasReviewQueue(process.env, { maxAttempts: 2 });
  assert.deepEqual({ pending: d1.pending, dlq: d1.dead_lettered }, { pending: 1, dlq: 0 });
  const d2 = await drainAsaasReviewQueue(process.env, { maxAttempts: 2 });
  assert.deepEqual({ dlq: d2.dead_lettered, alerted: d2.alerted }, { dlq: 1, alerted: 1 }, JSON.stringify(d2));
  assert.ok(kvStore.has("asaas:webhook:dlq:v1:" + early.id));
  assert.equal(world.emails.length - e0, 1);
  assert.match(world.emails.at(-1).subject, /asaas-webhook/);
  assert.match(world.emails.at(-1).text, new RegExp(early.id));
  const d3 = await drainAsaasReviewQueue(process.env, { maxAttempts: 2 });
  assert.equal(d3.checked, 0);
  assert.equal(world.emails.length - e0, 1, "um único alerta");
  assert.notEqual(order(o.order_id).status, "paid");
  assert.equal(countEvents(o.order_id), 0);
});

test("W8 repro Sol #879: e-mail do alerta da DLQ FALHA (Resend 500) => pendência persistida; a drenagem seguinte entrega UM e-mail com Idempotency-Key; depois nunca reenvia", { skip: SKIP }, async () => {
  clearReview();
  process.env.RESEND_API_KEY = "re_synthetic";
  psqlRaw("delete from asaas_dlq_alerts;\n");
  const { o, p } = await asaasPaidSetup();
  p.status = "REFUNDED"; p.refunds = [{ status: "DONE", value: 197 }];
  const early = evt("PAYMENT_REFUNDED", p.id);
  assert.equal((await hook(early)).body.reason, "refund_before_payment_recorded");
  const { drainAsaasReviewQueue } = await import("../../worker/cloudflare-worker.recovered.mjs");
  const e0 = world.emails.length;
  world.resendFail = 1;
  const d1 = await drainAsaasReviewQueue(process.env, { maxAttempts: 1, alertBaseBackoffMs: 1 });
  assert.deepEqual({ dlq: d1.dead_lettered, alerted: d1.alerted, failed: d1.alert_failed }, { dlq: 1, alerted: 0, failed: 1 }, JSON.stringify(d1));
  assert.equal(world.emailFailures >= 1, true);
  assert.equal(kvStore.has("asaas:webhook:review:v1:" + early.id), false, "item saiu da fila");
  assert.equal(JSON.parse(kvStore.get("asaas:webhook:dlq-alert:v1:" + early.id)).state, "pending", "pendência do alerta persistida");
  const key = "asaas-dlq-alert-v1-" + early.id;
  assert.equal(rowsSync("select state from asaas_dlq_alerts where idempotency_key=$1", [key])[0].state, "pending");
  await new Promise((r) => setTimeout(r, 20));
  const d2 = await drainAsaasReviewQueue(process.env, { maxAttempts: 1, alertBaseBackoffMs: 1 });
  assert.deepEqual({ checked: d2.checked, alerted: d2.alerted }, { checked: 0, alerted: 1 }, JSON.stringify(d2));
  assert.equal(world.emails.length - e0, 1);
  assert.equal(world.emails.at(-1).idem, key, "Idempotency-Key repassado ao Resend");
  assert.match(world.emails.at(-1).text, new RegExp(early.id));
  assert.equal(rowsSync("select state from asaas_dlq_alerts where idempotency_key=$1", [key])[0].state, "sent");
  assert.equal(JSON.parse(kvStore.get("asaas:webhook:dlq:v1:" + early.id)).alert.state, "sent");
  for (let i = 0; i < 2; i++) await drainAsaasReviewQueue(process.env, { maxAttempts: 1, alertBaseBackoffMs: 1 });
  assert.equal(world.emails.length - e0, 1, "nunca reenvia depois do sucesso");
  assert.notEqual(order(o.order_id).status, "paid");
});

test("C10 sondagem com cauda lenta (banco lento + MP sem resposta): o PRAZO da sondagem aborta a chamada ao MP antes do lease vencer; a 2ª sondagem nunca coexiste", { skip: SKIP }, async () => {
  psqlRaw("delete from psp_circuit_probes;\n");
  // Lease 1 600 ms, folga 300 ms => prazo 1 300 ms; timeout do MP 1 000 ms + orçamento de banco 300 ms = 1 300 ms (válido).
  globalThis.__ZEVANORY_PSP_PROBE_TIMING__ = { leaseMs: 1600, safetyMs: 300, dbBudgetMs: 300 };
  await kv.put("psp:circuit:v1:mercadopago", JSON.stringify({ failures: [], opened_at: Date.now() - 121_000 }));
  world.mp.mode = "slow_tail";
  world.mp.inflight = 0;
  world.sqlDelayMs = 120; // banco acima do orçamento: a chamada ao MP só sai depois de várias consultas lentas
  const mp0 = mpPrefCalls();
  const t0 = Date.now();
  const probe = await checkout();
  const elapsed = Date.now() - t0;
  world.sqlDelayMs = 0;
  assert.equal(mpPrefCalls() - mp0, 1, "a sondagem chegou ao MP");
  const call = world.mp.calls.filter((c) => c.path === "/checkout/preferences").at(-1);
  assert.equal(call.signal?.aborted, true);
  assert.equal(call.signal.reason?.name, "PspProbeDeadlineError", `chamada ao MP cortada pelo PRAZO da sondagem (não pelo timeout de 1 s): ${call.signal.reason?.name}`);
  assert.equal(world.mp.inflight, 0, "nenhuma chamada da 1ª sondagem em voo");
  assert.ok(world.mp.abortedAt - t0 < 1600, `abortada antes do lease (${world.mp.abortedAt - t0} ms)`);
  assert.equal(probe.status, 503, JSON.stringify(probe.body));
  assert.ok(elapsed < 1600 + 2000, `orquestrador não espera além do prazo (${elapsed} ms)`);
  // Com o lease ainda vivo, outra sondagem não é admitida (e o disjuntor reabriu: vai ao Asaas).
  const live = rowsSync("select count(*)::int as n from psp_circuit_probes where provider='mercadopago' and lease_until > now()")[0].n;
  if (live === "1") {
    const other = await checkout();
    assert.equal(other.body.provider, "asaas", JSON.stringify(other.body));
    assert.equal(mpPrefCalls() - mp0, 1);
  }
});
