// T4 local (plan 3.1): the REAL production webhook handler of the bundle
// (worker/cloudflare-worker.recovered.mjs -> handleMercadoPagoWebhook) driven with SYNTHETIC data.
//   * database: a throwaway local PostgreSQL behind a fake Neon HTTP endpoint (real SQL semantics);
//   * Mercado Pago API: a local fixture (no call leaves the machine); Resend: recorded, never sent;
//   * KV: in-memory. No credentials, no payments, no e-mails, no cost.
// Run: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --import ./tests/t4_sim/register.mjs --test tests/integration/mercadopago-webhook-postgres.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const SECRET = "t4-synthetic-webhook-secret";
const realFetch = globalThis.fetch;

// ---------- PostgreSQL through psql (the Neon HTTP protocol is emulated on top) ----------
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (q, params) => q.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
function psqlRaw(input) {
  return execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "--csv", "-q", "-f", "-"], { input, encoding: "utf8" });
}
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') { q = true; quoted = true; } else if (c === ",") { row.push(quoted || cur !== "" ? cur : null); cur = ""; quoted = false; }
    else if (c === "\n") { row.push(quoted || cur !== "" ? cur : null); rows.push(row); row = []; cur = ""; quoted = false; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(quoted || cur !== "" ? cur : null); rows.push(row); }
  return rows;
}
const OID = { boolean: 16, integer: 23, bigint: 20, smallint: 21, numeric: 1700, text: 25, uuid: 2950, json: 114, jsonb: 3802,
  "timestamp with time zone": 1184, "character varying": 1043 };
export const sqlLog = [];
function runQuery(query, params = []) {
  const q = inline(query, params).trim().replace(/;\s*$/, "");
  sqlLog.push(q.slice(0, 120));
  let desc = [];
  try { desc = parseCsv(psqlRaw(q + "\n\\gdesc\n")).slice(1).filter((r) => r.length >= 2); } catch { desc = []; }
  const out = parseCsv(psqlRaw(q + ";\n"));
  if (!desc.length) return { fields: [], rows: [], command: "OK", rowCount: 0 };
  const [head, ...rows] = out;
  return { fields: head.map((name, i) => ({ name, dataTypeID: OID[desc[i]?.[1]] ?? 25 })), rows, command: "SELECT", rowCount: rows.length };
}

// ---------- fakes ----------
export const world = { payments: new Map(), mpCalls: [], emails: [], idem: new Map(), resendStatus: 200, dbDown: false };
const kvStore = new Map();
const kv = { async get(k) { return kvStore.get(k) ?? null; }, async put(k, v) { kvStore.set(k, String(v)); }, async delete(k) { kvStore.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } };

function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  if (url.pathname === "/sql" && init.headers?.["Neon-Connection-String"]) {
    if (world.dbDown) return Promise.reject(new Error("synthetic database outage"));
    const body = JSON.parse(init.body);
    try {
      const result = body.queries ? { results: body.queries.map((x) => runQuery(x.query, x.params)) } : runQuery(body.query, body.params);
      return Promise.resolve(new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } }));
    } catch (e) {
      return Promise.resolve(new Response(JSON.stringify({ message: String(e.stderr || e.message).slice(0, 300) }), { status: 400 }));
    }
  }
  if (url.hostname === "api.mercadopago.com") {
    world.mpCalls.push({ method: init.method || "GET", path: url.pathname, auth: String(init.headers?.authorization || "").slice(0, 14) });
    const m = url.pathname.match(/^\/v1\/payments\/(\d+)$/);
    const p = m && world.payments.get(m[1]);
    return Promise.resolve(p ? new Response(JSON.stringify(p), { status: 200 }) : new Response("{}", { status: 404 }));
  }
  if (url.hostname === "api.resend.com") {
    if (world.failBeforeAccept) return Promise.reject(new Error("synthetic crash before the provider accepted"));
    const b = JSON.parse(init.body);
    // Semântica documentada do Resend (idempotência 24 h): mesma chave + mesmo corpo => resposta original
    // sem novo envio; mesma chave + corpo diferente => 409 invalid_idempotent_request.
    const key = init.headers?.["Idempotency-Key"];
    if (key && world.resendStatus === 200 && world.idem.has(key)) {
      const prev = world.idem.get(key);
      if (prev.body !== init.body) return Promise.resolve(new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }));
      return Promise.resolve(new Response(JSON.stringify({ id: prev.id }), { status: 200 }));
    }
    world.emails.push({ to: b.to, subject: b.subject, idem: key, text: b.text });
    if (world.resendStatus === 200 && key) world.idem.set(key, { body: init.body, id: "sim-" + world.emails.length });
    if (world.dropResponse) return Promise.reject(new Error("synthetic lost response after provider accepted"));
    return Promise.resolve(new Response(JSON.stringify(world.resendStatus === 200 ? { id: "sim-" + world.emails.length } : {}), { status: world.resendStatus }));
  }
  return Promise.reject(new Error("T4: unexpected external call blocked: " + url.hostname));
}

// ---------- helpers ----------
const sign = (paymentId, requestId, ts = Math.floor(Date.now() / 1000)) =>
  `ts=${ts},v1=${createHmac("sha256", SECRET).update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest("hex")}`;
async function webhook(paymentId, { signature, requestId = randomUUID(), body } = {}) {
  const res = await realFetch("http://127.0.0.1:8788/api/webhooks?provider=mercadopago&data.id=" + paymentId, {
    method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId, "x-signature": signature ?? sign(paymentId, requestId) },
    body: JSON.stringify(body ?? { type: "payment", action: "payment.updated", data: { id: String(paymentId) } }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
let seq = 1000000;
let bundle = null;
function newOrder({ amount = "197.00", status = "checkout_ready", sku = "ZEV-IA-011" } = {}) {
  const id = randomUUID();
  runQuery(`insert into orders (order_id, offer_id, amount, provider, external_reference, status) values ($1,$2,$3,'mercadopago',$4,$5)`,
    [id, sku, amount, `ZEVANORY:EXP-0001:${id}`, status]);
  return { id, ref: `ZEVANORY:EXP-0001:${id}`, amount: Number(amount) };
}
function pay(order, overrides = {}) {
  const id = String(++seq);
  world.payments.set(id, { id: Number(id), status: "approved", transaction_amount: order.amount, transaction_amount_refunded: 0,
    currency_id: "BRL", external_reference: order.ref, live_mode: true, payer: { email: "comprador.sintetico@example.com" }, ...overrides });
  return id;
}
const one = (q, p) => runQuery(q, p).rows[0];
const orderStatus = (id) => one("select status from orders where order_id=$1", [id])?.[0];
const fulfillment = (id) => one("select status, evidence_ref from service_fulfillment where order_id=$1", [id]);
const events = (id) => Number(one("select count(*)::int from financial_events where order_id=$1", [id])[0]);
const tokens = (id) => Number(one("select count(*)::int from artifact_download_tokens where order_id=$1", [id])[0]);

before(async () => {
  if (SKIP) return;
  psqlRaw(readFileSync(new URL("../t4_sim/schema.sql", import.meta.url), "utf8"));
  Object.assign(process.env, { DATABASE_URL: "postgresql://sim:sim@ep-t4-sim.local/neondb", FINANCIAL_EVENTS_ENABLED: "true",
    MERCADOPAGO_ACCESS_TOKEN: "APP_USR-synthetic", MERCADOPAGO_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_synthetic",
    MERCADOPAGO_ENV: "production", PAYMENT_PUBLIC_BASE_URL: "https://zevanory.api.br" });
  globalThis.__ZEVANORY_PRIVATE_KV__ = kv;
  globalThis.fetch = fakeFetch;
  bundle = await import("../../worker/cloudflare-worker.recovered.mjs");
  for (let i = 0; i < 50; i++) { try { await realFetch("http://127.0.0.1:8788/api/health"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { if (!SKIP) setTimeout(() => process.exit(process.exitCode || 0), 50); });

// ---------- matrix ----------
test("M1 signature: forged, stale and wrong-id signatures are rejected before any provider call", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  const calls = world.mpCalls.length;
  assert.equal((await webhook(id, { signature: "ts=1,v1=" + "0".repeat(64) })).status, 401);
  assert.equal((await webhook(id, { signature: sign(id, "req-x", Math.floor(Date.now() / 1000) - 3600), requestId: "req-x" })).status, 401, "older than 10 min");
  assert.equal((await webhook(id, { signature: sign("999999", "req-y"), requestId: "req-y" })).status, 401, "signed for another payment");
  assert.equal(world.mpCalls.length, calls, "no provider GET on an unauthenticated webhook");
  assert.equal(orderStatus(o.id), "checkout_ready");
  assert.ok([...kvStore.keys()].some((k) => k.startsWith("mercadopago:webhook-recovery:v1:")), "invalid signature queued for provider-truth recovery");
});

test("M2 independent confirmation: status and amount come from the provider GET, not the webhook body", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o, { status: "pending" });
  const r = await webhook(id, { body: { type: "payment", data: { id }, status: "approved", transaction_amount: o.amount } });
  assert.equal(r.status, 200); assert.equal(r.body.reason, "non_final_payment");
  assert.equal(world.mpCalls.at(-1).path, `/v1/payments/${id}`);
  assert.equal(orderStatus(o.id), "checkout_ready", "a body claiming 'approved' changes nothing");
  world.payments.delete(id);
  assert.equal((await webhook(id)).status, 503, "provider GET failure: not accepted, so Mercado Pago retries");
});

test("M3+M8 approved: paid once, delivered once (one e-mail), duplicates are idempotent", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  const mails = world.emails.length;
  const r1 = await webhook(id);
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.duplicate, false);
  assert.equal(orderStatus(o.id), "paid");
  assert.equal(fulfillment(o.id)[0], "delivered");
  assert.equal(world.emails.length - mails, 1); assert.equal(world.emails.at(-1).to[0], "comprador.sintetico@example.com");
  assert.match(world.emails.at(-1).idem, new RegExp(`^zevanory-delivery-${id}-[0-9a-f]{16}$`));
  const t = tokens(o.id);
  for (let i = 0; i < 3; i++) { const r = await webhook(id); assert.equal(r.status, 200); assert.equal(r.body.duplicate, true); }
  assert.equal(events(o.id), 1, "one financial event"); assert.equal(world.emails.length - mails, 1, "no second e-mail");
  assert.equal(tokens(o.id), t, "no new download tokens on duplicates");
});

test("M3 concurrent duplicates: parallel deliveries of the same approval insert one event", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  const mails = world.emails.length;
  const rs = await Promise.all([webhook(id), webhook(id), webhook(id)]);
  const sent = world.emails.slice(mails);
  console.log("T4_M3_CONCURRENT", JSON.stringify({ statuses: rs.map((r) => r.status), emails_attempted: sent.length, tokens: tokens(o.id) }));
  assert.ok(sent.length >= 1 && sent.every((m) => m.idem === sent[0].idem && m.idem.startsWith(`zevanory-delivery-${id}-`)), "every send carries the same provider idempotency key");
  assert.ok(rs.every((r) => r.status === 200 || r.status === 503), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(events(o.id), 1); assert.equal(orderStatus(o.id), "paid");
  assert.equal(rs.filter((r) => r.body.duplicate === false).length, 1);
});

test("M4 out of order: pending after approved is ignored; approved after a full refund is refused", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  await webhook(id);
  world.payments.get(id).status = "pending";
  assert.equal((await webhook(id)).body.reason, "non_final_payment");
  assert.equal(orderStatus(o.id), "paid");
  Object.assign(world.payments.get(id), { status: "refunded", transaction_amount_refunded: o.amount });
  assert.equal((await webhook(id)).status, 200);
  assert.equal(orderStatus(o.id), "refunded");
  Object.assign(world.payments.get(id), { status: "approved", transaction_amount_refunded: 0 });
  const late = await webhook(id);
  console.log("T4_M4_LATE_APPROVAL", JSON.stringify({ status: late.status, body: late.body }));
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.error, "order_state_invalid", "the state machine refuses it (non-2xx: the provider will retry it)");
  assert.equal(orderStatus(o.id), "refunded", "a late approval never reopens a refunded order");
  assert.equal(events(o.id), 2, "approval + refund only");
});

test("M5 rejected / in_process / cancelled / foreign currency / amount mismatch never deliver", { skip: SKIP }, async () => {
  for (const [over, expectStatus, reason] of [[{ status: "rejected" }, 200, "non_final_payment"], [{ status: "in_process" }, 200, "non_final_payment"],
    [{ status: "cancelled" }, 200, "non_final_payment"], [{ currency_id: "USD" }, 200, "non_final_payment"], [{ transaction_amount: 1.97 }, 409, null]]) {
    const o = newOrder(); const id = pay(o, over); const mails = world.emails.length;
    const r = await webhook(id);
    assert.equal(r.status, expectStatus, JSON.stringify([over, r.body]));
    if (reason) assert.equal(r.body.reason, reason); else assert.equal(r.body.error, "payment_amount_mismatch");
    assert.equal(orderStatus(o.id), "checkout_ready"); assert.equal(tokens(o.id), 0); assert.equal(world.emails.length, mails);
  }
  const o = newOrder(); const id = pay(o, { external_reference: "ZEVANORY:EXP-0001:" + randomUUID() });
  assert.equal((await webhook(id)).body.reason, "unlinked_payment", "payment for an unknown order");
});

test("M7 refunds: partial keeps access, full cancels fulfillment and blocks token use; chargeback = full", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o); await webhook(id);
  Object.assign(world.payments.get(id), { status: "partially_refunded", transaction_amount_refunded: 50 });
  assert.equal((await webhook(id)).status, 200);
  assert.equal(orderStatus(o.id), "partially_refunded"); assert.equal(fulfillment(o.id)[0], "delivered");
  Object.assign(world.payments.get(id), { status: "refunded", transaction_amount_refunded: o.amount });
  assert.equal((await webhook(id)).status, 200);
  assert.equal(orderStatus(o.id), "refunded"); assert.equal(fulfillment(o.id)[0], "canceled");
  // The token consumption query (recovered consumeArtifactDownload) requires orders.status='paid'.
  const usable = one(`select count(*)::int from artifact_download_tokens t where t.order_id=$1 and t.used_at is null and t.expires_at>now()
    and exists(select 1 from orders o where o.order_id=t.order_id and o.status='paid')`, [o.id])[0];
  assert.equal(Number(usable), 0, "no download token is usable after a full refund");
  const c = newOrder(); const cid = pay(c); await webhook(cid);
  world.payments.get(cid).status = "charged_back";
  assert.equal((await webhook(cid)).status, 200);
  assert.equal(orderStatus(c.id), "refunded"); assert.equal(fulfillment(c.id)[0], "canceled");
});

test("M9 recovery: database outage is not accepted (503, retried by the provider) and nothing is half-written", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  world.dbDown = true;
  const r = await webhook(id);
  world.dbDown = false;
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(orderStatus(o.id), "checkout_ready"); assert.equal(events(o.id), 0);
  const again = await webhook(id);
  assert.equal(again.status, 200); assert.equal(orderStatus(o.id), "paid"); assert.equal(events(o.id), 1);
});

test("M9 recovery: e-mail provider failure keeps the order paid, delivery pending and retriable without double charge", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  world.resendStatus = 500;
  const r = await webhook(id);
  world.resendStatus = 200;
  assert.equal(r.status, 503); assert.equal(r.body.error, "paid_order_delivery_pending");
  assert.equal(orderStatus(o.id), "paid"); assert.equal(events(o.id), 1); assert.notEqual(fulfillment(o.id)[0], "delivered");
  const mails = world.emails.length;
  const retry = await webhook(id);
  assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true);
  assert.equal(fulfillment(o.id)[0], "delivered"); assert.equal(world.emails.length - mails, 1);
  assert.equal(events(o.id), 1, "the retry does not create a second financial event");
});

test("M6 reconciliation: the watchdog replays queued unsigned webhooks via the provider and finishes stuck deliveries", { skip: SKIP }, async () => {
  // (a) a payment whose webhook arrived with an invalid signature (queued by M1-style handling)
  const a = newOrder(); const aid = pay(a);
  assert.equal((await webhook(aid, { signature: "ts=1,v1=" + "0".repeat(64) })).status, 401);
  // (b) a paid order whose delivery e-mail failed more than 15 minutes ago
  const b = newOrder(); const bid = pay(b);
  world.resendStatus = 500; await webhook(bid); world.resendStatus = 200;
  runQuery("update financial_events set received_at = now() - interval '20 minutes' where order_id=$1", [b.id]);
  // The scheduled handler passes the Worker env, whose fail-closed flags hydrate process.env
  // (hydrateRuntimeConfig): give it the same production flags the Worker has.
  const out = await bundle.runPaidDeliveryWatchdog({ ...process.env, ZEVANORY_PRIVATE_ARTIFACTS: kv });
  console.log("T4_M6_WATCHDOG", JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(orderStatus(a.id), "paid", "queued payment confirmed through the provider GET");
  assert.equal(fulfillment(a.id)[0], "delivered");
  assert.equal(fulfillment(b.id)[0], "delivered", "stuck delivery completed");
  assert.equal(events(a.id), 1); assert.equal(events(b.id), 1);
  assert.equal([...kvStore.keys()].filter((k) => k === "mercadopago:webhook-recovery:v1:" + aid).length, 0, "recovery entry drained");
});

test("M10 segregation: the production route never uses the test credential; no unexpected external host", { skip: SKIP }, async () => {
  process.env.MERCADOPAGO_TEST_ACCESS_TOKEN = "TEST-synthetic";
  const o = newOrder(); const id = pay(o); await webhook(id);
  assert.ok(world.mpCalls.filter((c) => c.path.endsWith(id)).every((c) => c.auth === "Bearer APP_USR"), JSON.stringify(world.mpCalls.slice(-2)));
  assert.ok(world.mpCalls.every((c) => c.method === "GET"), "the webhook path only reads the provider");
});

// ---------- M11: política do proprietário (20/10/2026): HONRAR pagamento aprovado com VENDAS FECHADAS ----------
// Comportamental (handler real + PostgreSQL descartável): interruptor explicitamente fechado.
function fecharVendas() {
  globalThis.__ZEVANORY_SALES_SWITCH__ = false;
  process.env.SALE_GLOBALLY_ENABLED = "false";
  kvStore.set("sales:open:v1", JSON.stringify({ enabled: false, at: new Date().toISOString() }));
}
test("M11a vendas fechadas: pagamento aprovado vira pago e é entregue uma única vez", { skip: SKIP }, async () => {
  fecharVendas();
  const o = newOrder(); const id = pay(o); const mails = world.emails.length;
  const r = await webhook(id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, false, "o webhook não abre vendas");
  assert.equal(orderStatus(o.id), "paid"); assert.equal(fulfillment(o.id)[0], "delivered");
  assert.equal(world.emails.length - mails, 1); assert.ok(tokens(o.id) >= 1);
  for (let i = 0; i < 2; i++) assert.equal((await webhook(id)).body.duplicate, true);
  assert.equal(events(o.id), 1); assert.equal(world.emails.length - mails, 1, "duplicata não reenvia");
});
test("M11b vendas fechadas: falha de e-mail -> pago, entrega pendente -> reprocesso entrega sem segunda cobrança", { skip: SKIP }, async () => {
  fecharVendas();
  const o = newOrder(); const id = pay(o);
  world.resendStatus = 500; const r = await webhook(id); world.resendStatus = 200;
  assert.equal(r.status, 503); assert.equal(r.body.error, "paid_order_delivery_pending");
  assert.equal(orderStatus(o.id), "paid"); assert.notEqual(fulfillment(o.id)[0], "delivered");
  assert.equal((await webhook(id)).status, 200);
  assert.equal(fulfillment(o.id)[0], "delivered"); assert.equal(events(o.id), 1);
});
test("M11c vendas fechadas: webhook atrasado/perdido (assinatura inválida) é recuperado pelo watchdog e entregue", { skip: SKIP }, async () => {
  fecharVendas();
  const a = newOrder(); const aid = pay(a);
  assert.equal((await webhook(aid, { signature: "ts=1,v1=" + "0".repeat(64) })).status, 401);
  assert.equal(orderStatus(a.id), "checkout_ready", "nada muda sem autenticidade");
  const out = await bundle.runPaidDeliveryWatchdog({ ...process.env, ZEVANORY_PRIVATE_ARTIFACTS: kv });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(orderStatus(a.id), "paid"); assert.equal(fulfillment(a.id)[0], "delivered"); assert.equal(events(a.id), 1);
});
test("M11d vendas fechadas: pendente, recusado ou valor divergente NUNCA viram pago", { skip: SKIP }, async () => {
  fecharVendas();
  for (const over of [{ status: "pending" }, { status: "rejected" }, { status: "in_process" }, { transaction_amount: 1.97 }]) {
    const o = newOrder(); const id = pay(o, over); const mails = world.emails.length;
    await webhook(id);
    assert.equal(orderStatus(o.id), "checkout_ready", JSON.stringify(over)); assert.equal(tokens(o.id), 0); assert.equal(world.emails.length, mails);
  }
});

// ---------- M12: renovação legítima do link de entrega não pode travar no 409 do Resend ----------
test("M12 entrega pendente com link expirado: novo link => nova chave => e-mail enviado (sem 409 preso)", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o);
  // 1ª tentativa: o Resend ACEITA a chave mas a resposta se perde (registra a chave sem confirmar ao chamador).
  const before = world.emails.length;
  world.resendStatus = 200; world.dropResponse = true;
  const r1 = await webhook(id);
  world.dropResponse = false;
  assert.equal(r1.status, 503, JSON.stringify(r1.body));
  assert.equal(orderStatus(o.id), "paid"); assert.notEqual(fulfillment(o.id)[0], "delivered");
  const k1 = world.emails.at(-1).idem;
  // O link guardado expira antes do reprocesso (ex.: fila parada): a recuperação gera link novo.
  const ev = JSON.parse(fulfillment(o.id)[1]); ev.expires_at = new Date(Date.now() - 60000).toISOString();
  runQuery("update service_fulfillment set evidence_ref=$2 where order_id=$1", [o.id, JSON.stringify(ev)]);
  const r2 = await webhook(id);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(fulfillment(o.id)[0], "delivered");
  const k2 = world.emails.at(-1).idem;
  assert.notEqual(k1, k2, "conteúdo renovado usa chave nova");
  assert.equal(world.emails.length - before, 2, "o cliente recebe o link válido");
  assert.equal(events(o.id), 1, "sem segunda cobrança");
});

test("M13 resposta perdida após o aceite, link ainda válido: reprocesso usa a MESMA chave => um único e-mail", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o); const before = world.emails.length;
  world.dropResponse = true; const r1 = await webhook(id); world.dropResponse = false;
  assert.equal(r1.status, 503); assert.equal(world.emails.length - before, 1, "o provedor aceitou um envio");
  const k1 = world.emails.at(-1).idem;
  const r2 = await webhook(id);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(fulfillment(o.id)[0], "delivered");
  assert.equal(world.emails.length - before, 1, "reprocesso deduplicado pelo provedor: nenhum segundo envio");
  assert.equal(world.idem.get(k1)?.id !== undefined, true);
});

// ---------- M14–M16: cenários de falha do processo de entrega (contestação GPT-6 016-F) ----------
test("M14 falha após CAS vencedor e antes do aceite do provedor: reprocesso reaproveita o MESMO link persistido e entrega", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o); const before = world.emails.length;
  world.failBeforeAccept = true; const r1 = await webhook(id); world.failBeforeAccept = false;
  assert.equal(r1.status, 503); assert.equal(world.emails.length, before, "nada foi aceito pelo provedor");
  const link1 = JSON.parse(fulfillment(o.id)[1]).download_url;
  assert.match(link1, /^https:\/\//, "evidência persistida pelo vencedor");
  const r2 = await webhook(id);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(fulfillment(o.id)[0], "delivered");
  assert.equal(JSON.parse(fulfillment(o.id)[1]).download_url, link1, "link persistido não foi perdido nem trocado");
  assert.ok(world.emails.at(-1).text.includes(link1), "o e-mail leva o link persistido");
  assert.equal(world.emails.length - before, 1); assert.equal(events(o.id), 1);
});

test("M15 fronteira de vencimento: link com > 10 min é reaproveitado; com < 10 min é renovado — o e-mail nunca leva link prestes a vencer", { skip: SKIP }, async () => {
  for (const [minutos, renova] of [[11, false], [9, true]]) {
    const o = newOrder(); const id = pay(o);
    world.failBeforeAccept = true; await webhook(id); world.failBeforeAccept = false;
    const ev = JSON.parse(fulfillment(o.id)[1]); const antigo = ev.download_url;
    ev.expires_at = new Date(Date.now() + minutos * 60000).toISOString();
    runQuery("update service_fulfillment set evidence_ref=$2 where order_id=$1", [o.id, JSON.stringify(ev)]);
    assert.equal((await webhook(id)).status, 200);
    const final = JSON.parse(fulfillment(o.id)[1]);
    assert.equal(final.download_url !== antigo, renova, `${minutos} min`);
    assert.ok(Date.parse(final.expires_at) > Date.now() + 10 * 60000, "link enviado tem pelo menos 10 min de validade");
    assert.ok(world.emails.at(-1).text.includes(final.download_url));
  }
});

test("M16 resposta perdida e recuperação DEPOIS da janela de 24 h do provedor: entrega concluída (e-mail idêntico pode repetir), nunca pendente para sempre", { skip: SKIP }, async () => {
  const o = newOrder(); const id = pay(o); const before = world.emails.length;
  world.dropResponse = true; await webhook(id); world.dropResponse = false;
  const k1 = world.emails.at(-1).idem, t1 = world.emails.at(-1).text;
  world.idem.clear();                                    // provedor esqueceu a chave (> 24 h)
  const r2 = await webhook(id);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(fulfillment(o.id)[0], "delivered", "não fica pendente");
  assert.equal(world.emails.length - before, 2, "política: no máximo um e-mail idêntico repetido após 24 h");
  assert.equal(world.emails.at(-1).idem, k1); assert.equal(world.emails.at(-1).text, t1, "mesmo conteúdo, mesmo link");
  assert.equal(events(o.id), 1, "sem segunda cobrança");
});

// ---------- M17–M18: achados da revisão do GitHub Copilot no #838 ----------
test("M17 evidência em branco ('' ou espaços) não trava a entrega (ramo texto, sem cast inválido para jsonb)", { skip: SKIP }, async () => {
  for (const branco of ["", "   "]) {
    const o = newOrder(); const id = pay(o);
    world.failBeforeAccept = true; await webhook(id); world.failBeforeAccept = false;
    runQuery("update service_fulfillment set evidence_ref=$2 where order_id=$1", [o.id, branco]);
    const r = await webhook(id);
    assert.equal(r.status, 200, JSON.stringify([branco, r.body]));
    assert.equal(fulfillment(o.id)[0], "delivered");
  }
});

// M18 (achado Copilot "coluna jsonb") NÃO tem teste comportamental: o próprio webhook grava evidence_ref
// com expressão text (INSERT ... service_fulfillment), e com coluna jsonb o PostgreSQL rejeita esse INSERT
// ("column evidence_ref is of type jsonb but expression is of type text") — verificado neste harness.
// Logo a coluna em uso é text; a leitura de objeto foi mantida apenas como defesa.
