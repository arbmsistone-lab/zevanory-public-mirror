import { test } from "node:test";
import assert from "node:assert/strict";
import { dueStep, renderPostSaleEmail, runPostSale, handlePostSale, optOutLink, POST_SALE_CATALOG } from "../worker/post-sale.mjs";

const HOUR = 3600e3, DAY = 24 * HOUR;

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

const NOW = Date.parse("2026-10-10T12:00:00Z");
const order = (id, offer, deliveredAgoMs, email, extra = {}) => ({
  order_id: id, offer_id: offer, status: "paid", certification_pilot: false,
  delivered_at: new Date(NOW - deliveredAgoMs).toISOString(),
  evidence_ref: JSON.stringify({ email_recipient: email, email_destination_kind: "payer", ...extra }),
});

function env(kv, overrides = {}) {
  return { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_test_key_123456", MERCADOPAGO_ENV: "production", ...overrides };
}

function captureFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); };
  return calls;
}

test("dueStep schedule", () => {
  assert.equal(dueStep(10 * HOUR, new Set()), null);
  assert.equal(dueStep(21 * HOUR, new Set()), "d1");
  assert.equal(dueStep(3 * DAY, new Set(["d1"])), null);
  assert.equal(dueStep(5 * DAY + HOUR, new Set(["d1"])), "d5");
  assert.equal(dueStep(5 * DAY + HOUR, new Set()), "d1", "d5 never before d1 inside the week");
  assert.equal(dueStep(8 * DAY, new Set()), "d5", "late order gets only the latest step");
  assert.equal(dueStep(6 * DAY, new Set(["d1", "d5"])), null);
  assert.equal(dueStep(16 * DAY, new Set()), null);
});

test("templates carry opt-out, support and the right next offer", () => {
  const d5 = renderPostSaleEmail("d5", { productName: "IA na Prática", productSlug: "ia-na-pratica", nextOffer: POST_SALE_CATALOG["ZEV-CMB-011"], optOutUrl: "https://zevanory.api.br/pos-venda/descadastrar?i=a&t=b" });
  assert.match(d5.text, /combo-ia-vendas/);
  assert.match(d5.text, /descadastrar/);
  assert.match(d5.text, /suporte@zevanory\.api\.br/);
  const top = renderPostSaleEmail("d5", { productName: "Negócio Completo", productSlug: "negocio-completo", nextOffer: null, optOutUrl: "u" });
  assert.doesNotMatch(top.text, /vendas\.zevanory\.api\.br\/(?!negocio-completo)/, "no upsell beyond the top package");
});

test("idle while sales are not in production", async () => {
  const kv = memoryKv();
  const calls = captureFetch();
  const out = await runPostSale(env(kv, { MERCADOPAGO_ENV: "sandbox" }), { sqlFactory: () => ({ query: async () => { throw new Error("must not query"); } }), now: NOW });
  assert.equal(out.idle, "sales_not_in_production");
  assert.equal(calls.length, 0);
});

test("sends only to real paying customers, once, and mirrors to the panel", async () => {
  const rows = [
    order("11111111-1111-4111-8111-111111111111", "ZEV-IA-011", 21 * HOUR, "cliente@empresa.com.br"),
    order("22222222-2222-4222-8222-222222222222", "ZEV-VEN-011", 21 * HOUR, "prova-sandbox@zevanory.api.br"),
    order("33333333-3333-4333-8333-333333333333", "ZEV-LCX-011", 21 * HOUR, "x@y.com", { email_destination_kind: "sandbox_controlled_inbox" }),
    order("44444444-4444-4444-8444-444444444444", "ZEV-CMB-011", 21 * HOUR, "teste@kv.com"),
    order("55555555-5555-4555-8555-555555555555", "ZEV-NGC-011", 21 * HOUR, "reembolso@cliente.com"),
  ];
  const kv = memoryKv({
    "sandbox-proof-v2:order:44444444-4444-4444-8444-444444444444": "1",
    "refund:req:55555555-5555-4555-8555-555555555555": "{}",
  });
  const calls = captureFetch();
  const sqlFactory = () => ({ query: async () => rows });
  const first = await runPostSale(env(kv), { sqlFactory, now: NOW });
  assert.equal(first.sent, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.to, ["cliente@empresa.com.br"]);
  assert.equal(calls[0].init.headers["Idempotency-Key"], "zevanory-post-sale-11111111-1111-4111-8111-111111111111-d1");
  assert.match(calls[0].body.headers["List-Unsubscribe"], /pos-venda\/descadastrar/);
  assert.equal(calls[0].body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const bridged = [...kv.store.keys()].filter((k) => k.startsWith("zpc-activity:v1:event:"));
  assert.equal(bridged.length, 1);
  assert.doesNotMatch(kv.store.get(bridged[0]), /cliente@empresa\.com\.br/, "panel never receives the full email");
  const second = await runPostSale(env(kv), { sqlFactory, now: NOW });
  assert.equal(second.sent, 0, "idempotent across ticks");
});

test("one-click opt-out stops further sends", async () => {
  const kv = memoryKv();
  const e = env(kv);
  const link = new URL(await optOutLink(e, "Cliente@Empresa.com.br"));
  const bad = await handlePostSale(new Request(link.origin + link.pathname + "?i=" + link.searchParams.get("i") + "&t=" + "0".repeat(32), { method: "POST" }), e, {});
  assert.equal(bad.status, 400);
  const ok = await handlePostSale(new Request(link.toString(), { method: "POST" }), e, {});
  assert.equal(ok.status, 200);
  const calls = captureFetch();
  const rows = [order("66666666-6666-4666-8666-666666666666", "ZEV-IA-011", 21 * HOUR, "cliente@empresa.com.br")];
  const out = await runPostSale(e, { sqlFactory: () => ({ query: async () => rows }), now: NOW });
  assert.equal(out.sent, 0);
  assert.equal(out.skipped.opted_out, 1);
  assert.equal(calls.length, 0);
});

test("certification route refuses real orders and requires the token", async () => {
  const kv = memoryKv();
  const e = env(kv, { CERTIFICATION_E2E_TOKEN: "c".repeat(40) });
  const real = order("77777777-7777-4777-8777-777777777777", "ZEV-IA-011", HOUR, "cliente@empresa.com.br");
  const sqlFactory = () => ({ query: async () => [real] });
  const noToken = await handlePostSale(new Request("https://zevanory.api.br/api/internal/certification/e2e/post-sale", { method: "POST", body: JSON.stringify({ order_id: real.order_id }) }), e, { sqlFactory });
  assert.equal(noToken.status, 401);
  const refused = await handlePostSale(new Request("https://zevanory.api.br/api/internal/certification/e2e/post-sale", { method: "POST", headers: { "x-certification-e2e-token": "c".repeat(40) }, body: JSON.stringify({ order_id: real.order_id }) }), e, { sqlFactory });
  assert.equal(refused.status, 409);
});
