import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { handleRefundFlow, runRefundWatchdog } from "../worker/refund-flow.mjs";
import { saveRefund } from "../worker/refund-provider-claims.mjs";
import { refundAutoDispatchEnabled, evaluateAutomaticRefund } from "../worker/refund-auto-dispatch.mjs";
import { refundWindow } from "../worker/politica-unica.mjs";

// Deliberately fake every external boundary. These tests must never need provider credentials.
const OID = "11111111-2222-4333-8444-555555555555";
const BUYER = "buyer@example.com";
const WRONG = "intruder@example.com";
const KEY = `refund:req:${OID}`;
const DAY = 86_400_000;
const HASH = createHash("sha256").update("123456789").digest("hex").slice(0, 16);
const order = (extra = {}) => ({ order_id: OID, status: "paid", amount: 197, offer_id: "ZEV-IA-011",
  certification_pilot: false, payment_id: "99887766", paid_at: new Date(Date.now() - DAY).toISOString(),
  delivered_at: new Date(Date.now() - DAY).toISOString(), first_download_at: null, ...extra });
const payment = (extra = {}) => ({ status: "approved", status_detail: "accredited", transaction_amount: 197,
  transaction_amount_refunded: 0, refunds: [], payer: { email: BUYER }, external_reference: OID,
  metadata: { zevanory_order_id: OID, offer_id: "ZEV-IA-011" }, ...extra });

function fixture({ item = order(), paid = payment(), delivery = BUYER, flag = "true", mode = "production",
  token = "APP_USR-FAKE-PRODUCTION-ABCDEFGHIJKLMNOP", refundBody = { id: "ref-1", status: "approved", amount: 197 },
  refundStatus = 200, failedEmailCount = 0, paymentGetError = false } = {}) {
  const state = new Map();
  let claim = null;
  const calls = { get: 0, post: 0, users: 0, emails: [], posts: [] };
  const kv = {
    get: async (key) => state.get(key) ?? null,
    put: async (key, value) => { state.set(key, value); },
    delete: async (key) => state.delete(key),
    list: async ({ prefix }) => ({ keys: [...state.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
  };
  const sql = { query: async (statement, args = []) => {
    if (statement.includes("from orders o")) return item ? [item] : [];
    if (statement.startsWith("select evidence_ref")) return delivery ? [{ evidence_ref: JSON.stringify({ email_recipient: delivery }) }] : [];
    if (statement.startsWith("select order_id,payment_id,test,stage")) return claim ? [{ ...claim }] : [];
    if (statement.startsWith("insert into refund_provider_claims")) {
      if (claim) return [];
      claim = { order_id: args[0], payment_id: args[1], test: args[2], stage: "provider_call_may_have_been_sent", claimed_at: new Date().toISOString(), reconciled_status: null };
      return [{ order_id: args[0] }];
    }
    if (statement.startsWith("update refund_provider_claims") && statement.includes("reconciled_refunded")) {
      if (claim) claim.stage = "reconciled_refunded";
      return [];
    }
    if (statement.startsWith("update refund_provider_claims")) return [];
    return [];
  } };
  const env = { REFUND_AUTO_DISPATCH: flag, MERCADOPAGO_ENV: mode,
    MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: HASH, MERCADOPAGO_ACCESS_TOKEN: token,
    MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-FAKE-SANDBOX", RESEND_API_KEY: "fake-resend",
    OWNER_ALERT_EMAIL: "owner@example.com", ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://fake.invalid/test" };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/users/me")) {
      calls.users++;
      return Response.json({ id: 123456789, site_id: "MLB", tags: [] });
    }
    if (target === "https://api.resend.com/emails") {
      calls.emails.push({ ...JSON.parse(options.body), headers: options.headers });
      if (failedEmailCount-- > 0) return Response.json({ message: "email rejected" }, { status: 503 });
      return Response.json({ id: "fake-email" });
    }
    if (target.includes("api.mercadopago.com") && options.method === "POST") {
      calls.post++;
      calls.posts.push(options);
      return Response.json(refundBody, { status: refundStatus });
    }
    if (target.includes("api.mercadopago.com")) {
      calls.get++;
      if (paymentGetError) throw new Error("offline fake Mercado Pago");
      return Response.json(paid);
    }
    throw new Error("X00: unexpected external endpoint " + target);
  };
  const request = (email = BUYER) => new Request("https://zevanory.api.br/api/support/refund-request", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
    body: JSON.stringify({ order_id: OID, email }),
  });
  const invoke = async (email = BUYER, ctx) => {
    const r = await handleRefundFlow(request(email), env, { sqlFactory: () => sql, ctx });
    return { status: r.status, body: await r.json() };
  };
  const panel = async () => (await handleRefundFlow(new Request("https://zevanory.api.br/admin/refunds"), env,
    { sqlFactory: () => sql, isAdminAuthorized: () => true })).text();
  const ownerAction = async (action) => {
    const r = await handleRefundFlow(new Request("https://zevanory.api.br/admin/refunds/action", {
      method: "POST", body: new URLSearchParams({ order_id: OID, action }) }), env,
      { sqlFactory: () => sql, isAdminAuthorized: () => true });
    return { status: r.status, text: await r.text() };
  };
  const watchdog = () => runRefundWatchdog(env, Date.now(), { sqlFactory: () => sql });
  return { state, calls, env, kv, invoke, panel, ownerAction, watchdog, claim: () => claim,
    restore: () => { globalThis.fetch = previousFetch; } };
}

test("X01 wrong-first cannot block buyer, no financial action or email to intruder", async () => {
  const x = fixture();
  try {
    const wrong = await x.invoke(WRONG);
    assert.equal(x.state.has(KEY), false, "X01 unverified never occupies request key");
    assert.equal(x.calls.post, 0, "X01 wrong identity never refunds");
    assert.ok([...x.state.keys()].some(k => k.startsWith("refund:unverified:")), "X01 separate audit record");
    const panel = await x.panel();
    assert.match(panel, /Tentativas com identidade não confirmada/, "X01 visible to owner");
    assert.doesNotMatch(panel.split("Tentativas com identidade não confirmada")[1], /Aprovar reembolso/, "X01 no approval for unverified");
    const correct = await x.invoke(BUYER);
    assert.deepEqual(wrong, correct, "X01 same status and body for correct/wrong identity");
    assert.equal(x.calls.post, 1, "X01 genuine buyer gets automatic refund");
    assert.ok(x.calls.emails.every(e => !e.to.includes(WRONG)), "X01 no email sent to submitted intruder address");
  } finally { x.restore(); }
});

test("X02 wrong email after approved has same receipt and cannot reveal order state", async () => {
  const x = fixture();
  try { const right = await x.invoke(); const wrong = await x.invoke(WRONG); assert.deepEqual(right, wrong, "X02 identical receipt"); assert.equal(x.calls.post, 1, "X02 no repeat"); }
  finally { x.restore(); }
});

test("X03 absent order has same generic receipt and never sends email", async () => {
  const x = fixture({ item: null });
  try { const a = await x.invoke(); const b = await x.invoke(WRONG); assert.deepEqual(a, b, "X03 no enum"); assert.equal(a.status, 200, "X03 generic HTTP"); assert.match(a.body.message, /Se os dados conferirem/, "X03 generic message"); assert.equal(x.calls.emails.length, 0, "X03 no email"); }
  finally { x.restore(); }
});

test("X04 automatic approved always returns protocol and a usable form message", async () => {
  const x = fixture();
  try { const out = await x.invoke(); assert.equal(out.status, 200, "X04"); assert.equal(out.body.protocol, OID, "X04"); assert.match(out.body.message, /Se os dados conferirem/, "X04"); assert.equal(JSON.parse(x.state.get(KEY)).status, "approved", "X04"); }
  finally { x.restore(); }
});

test("X05 provider outcome_unknown does not expose upstream text to consumer", async () => {
  const x = fixture({ refundStatus: 500, refundBody: { message: "private-provider-debug-info" } });
  try { const out = await x.invoke(); assert.match(out.body.message, /Se os dados conferirem/, "X05"); assert.doesNotMatch(JSON.stringify(out), /private-provider-debug-info/, "X05"); assert.match(JSON.parse(x.state.get(KEY)).last_error, /private-provider-debug-info/, "X05 dashboard diagnostic"); assert.equal(x.calls.post, 1, "X05"); }
  finally { x.restore(); }
});

test("X06 complete status+detail allowlist permits accredited only", () => {
  const ok = { order: order(), payment: payment(), window: { eligible: true }, identityMatched: true, test: false, credential: { ok: true } };
  assert.equal(evaluateAutomaticRefund(ok).eligible, true, "X06 baseline");
  for (const status_detail of ["partially_refunded", "pending", "", null, "accredited_extra"])
    assert.equal(evaluateAutomaticRefund({ ...ok, payment: payment({ status_detail }) }).eligible, false, "X06 denied " + status_detail);
});

test("X07 missing refunded amount is unknown, not zero", () => {
  assert.equal(evaluateAutomaticRefund({ order: order(), payment: payment({ transaction_amount_refunded: undefined }), window: { eligible: true }, identityMatched: true, test: false, credential: { ok: true } }).reason, "refund_snapshot_unverified", "X07");
});

test("X08 missing refunds list blocks automatic refund", () => {
  assert.equal(evaluateAutomaticRefund({ order: order(), payment: payment({ refunds: null }), window: { eligible: true }, identityMatched: true, test: false, credential: { ok: true } }).reason, "refund_snapshot_unverified", "X08");
});

test("X09 partial refund blocks automatic refund", async () => {
  const x = fixture({ paid: payment({ status_detail: "partially_refunded", transaction_amount_refunded: 50 }) });
  try { assert.equal((await x.invoke()).status, 200, "X09"); assert.equal(x.calls.post, 0, "X09"); assert.equal(JSON.parse(x.state.get(KEY)).auto_eligible, false, "X09"); }
  finally { x.restore(); }
});

test("X10 manual path includes protocol, message, reason and no POST", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 196 }) });
  try { const out = await x.invoke(); assert.equal(out.body.protocol, OID, "X10"); assert.match(out.body.message, /Se os dados conferirem/, "X10"); assert.equal(x.calls.post, 0, "X10"); const page = await x.panel(); assert.match(page, /payment_amount_mismatch/, "X10 manual reason"); assert.match(page, /há \d+ min/, "X10 age minutes"); }
  finally { x.restore(); }
});

test("X11 strict true flag; malformed values stay on legacy OFF path", async () => {
  for (const flag of [" TRUE", "True", "true ", "TRUE", true]) assert.equal(refundAutoDispatchEnabled({ REFUND_AUTO_DISPATCH: flag }), false, "X11");
});

test("X12 OFF preserves legacy email subjects, recipients and body bytes", async () => {
  const source = readFileSync(new URL("../worker/refund-flow.mjs", import.meta.url), "utf8");
  const legacyBlock = source.slice(source.indexOf("async function createRequest("), source.indexOf("// Only the ON flow uses this path"));
  assert.equal(createHash("sha256").update(legacyBlock).digest("hex"), "9996d28187f4585e16d89b91d4b9644912b24df1dd51b90f778be4f773e08ee9", "X12 baseline source identical to a098d880");
  const x = fixture({ flag: "false" });
  try {
    const out = await x.invoke();
    assert.deepEqual(out.body, { received: true, status: "pending", message: "Pedido de reembolso registrado. Você receberá a confirmação por e-mail." }, "X12 response");
    assert.equal(x.calls.post, 0, "X12");
    const r = JSON.parse(x.state.get(KEY));
    const expiry = refundWindow({ paidAt: r.paid_at, deliveredAt: r.received_at, now: Date.now() }).ends_at;
    assert.equal(Object.hasOwn(r, "auto_dispatch"), false, "X12 record legacy shape");
    assert.deepEqual(x.calls.emails.map(e => ({ to: e.to, subject: e.subject, text: e.text })), [
      { to: ["owner@example.com"], subject: "ZEVANORY — novo pedido de reembolso para aprovar",
        text: `Pedido ${OID} (ZEV-IA-011, R$ 197) solicitou reembolso dentro do prazo de arrependimento (até ${expiry}).\n\nAprovar: https://zevanory.api.br/admin/refunds` },
      { to: [BUYER], subject: "ZEVANORY — recebemos seu pedido de reembolso",
        text: `Recebemos o pedido de reembolso do pedido ${OID}. O valor volta pelo mesmo meio de pagamento assim que o processamento for concluído. Você receberá a confirmação por e-mail.\n\nEquipe ZEVANORY · suporte@zevanory.api.br` },
    ], "X12 exact legacy emails");
  } finally { x.restore(); }
  const wrong = fixture({ flag: "false" });
  try { assert.equal((await wrong.invoke(WRONG)).status, 404, "X12 OFF email mismatch"); assert.equal(wrong.state.has(KEY), false, "X12 no wrong record"); }
  finally { wrong.restore(); }
  const unpaid = fixture({ flag: "false", item: order({ status: "created" }) });
  try { assert.equal((await unpaid.invoke()).status, 404, "X12 OFF unpaid order"); assert.equal(unpaid.calls.emails.length, 0, "X12 no mails for unpaid"); }
  finally { unpaid.restore(); }
});

test("X13 mixed-case sandbox token in production denied before provider GET", async () => {
  const x = fixture({ token: "TeSt-FAKE-NONPROD" });
  try { await x.invoke(); assert.equal(x.calls.get, 0, "X13 no payment GET"); assert.equal(x.calls.post, 0, "X13 no POST"); assert.equal(JSON.parse(x.state.get(KEY)).manual_reason, "credential_environment_mismatch", "X13"); }
  finally { x.restore(); }
});

test("X14 wrong environment fails closed, even when token resembles production", async () => {
  const x = fixture({ mode: "sandbox" });
  try { await x.invoke(); assert.equal(x.calls.get, 0, "X14"); assert.equal(x.calls.post, 0, "X14"); }
  finally { x.restore(); }
});

test("X15 missing account hash cannot be accepted by prefix alone", async () => {
  const x = fixture();
  try { delete x.env.MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16; await x.invoke(); assert.equal(x.calls.get, 0, "X15"); assert.equal(x.calls.post, 0, "X15"); }
  finally { x.restore(); }
});

test("X16 unverified payment payer/delivery conflict creates no active request", async () => {
  const x = fixture({ delivery: "delivery@example.com" });
  try { await x.invoke(); assert.equal(x.state.has(KEY), false, "X16"); assert.equal(x.calls.post, 0, "X16"); }
  finally { x.restore(); }
});

test("X17 failed receipt email is retried by watchdog with stable idempotency key", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 196 }), failedEmailCount: 1 });
  try {
    await x.invoke();
    assert.equal(JSON.parse(x.state.get(KEY)).customer_email_pending, true, "X17 pending");
    const first = x.calls.emails.find(e => e.to.includes(BUYER));
    assert.ok(first?.headers["idempotency-key"], "X17 provider dedup key");
    await x.watchdog();
    const second = x.calls.emails.filter(e => e.to.includes(BUYER));
    assert.equal(second.length, 2, "X17 retry");
    assert.equal(second[0].headers["idempotency-key"], second[1].headers["idempotency-key"], "X17 stable key");
    assert.equal(JSON.parse(x.state.get(KEY)).customer_email_pending, false, "X17 delivered marker");
  } finally { x.restore(); }
});

test("X18 owner alert for mismatched account is deduplicated", async () => {
  const x = fixture({ token: "TeSt-FAKE-NONPROD" });
  try { await x.invoke(); await x.ownerAction("approve"); await x.invoke(); assert.equal(x.calls.emails.filter(e => /credencial incompatível/.test(e.subject)).length, 1, "X18"); }
  finally { x.restore(); }
});

test("X19 evidence for sandbox never produces a credential mismatch alert", async () => {
  const x = fixture({ item: order({ certification_pilot: true }) });
  try { await x.invoke(); assert.equal(x.calls.emails.filter(e => /credencial incompatível/.test(e.subject)).length, 0, "X19"); assert.equal(x.calls.post, 0, "X19"); }
  finally { x.restore(); }
});

test("X20 stale pending write cannot overwrite approved version", async () => {
  const x = fixture();
  try { x.state.set(KEY, JSON.stringify({ order_id: OID, status: "approved", auto_dispatch: true, version: 5 })); const ok = await saveRefund(x.kv, { order_id: OID, status: "pending", auto_dispatch: true, version: 2 }); assert.equal(ok, false, "X20"); assert.equal(JSON.parse(x.state.get(KEY)).status, "approved", "X20"); }
  finally { x.restore(); }
});

test("X21 paid order without payment_confirmed is manual with protocol, not 404", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try { const out = await x.invoke(); assert.equal(out.status, 200, "X21"); assert.equal(out.body.protocol, OID, "X21"); assert.equal(JSON.parse(x.state.get(KEY)).manual_reason, "payment_event_missing", "X21"); assert.equal(x.calls.post, 0, "X21"); assert.doesNotMatch(await x.panel(), /<button name="action" value="approve">/, "X21 no unsafe approval"); }
  finally { x.restore(); }
});

test("X22 owner cannot POST a refund when payment event is missing", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try { await x.invoke(); assert.equal((await x.ownerAction("approve")).status, 409, "X22"); assert.equal(x.calls.post, 0, "X22"); }
  finally { x.restore(); }
});

test("X23 after owner rejection a verified new request is manual with history", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 196 }) });
  try { await x.invoke(); assert.equal((await x.ownerAction("reject")).status, 303, "X23 reject"); await x.invoke(); const r = JSON.parse(x.state.get(KEY)); assert.equal(r.manual_reason, "previously_rejected", "X23"); assert.equal(r.history.length, 1, "X23 history"); assert.equal(x.calls.post, 0, "X23 no automatic POST"); }
  finally { x.restore(); }
});

test("X24 refund response amount mismatch can never become approved", async () => {
  const x = fixture({ refundBody: { id: "ref-1", status: "approved", amount: 196 } });
  try { await x.invoke(); assert.equal(JSON.parse(x.state.get(KEY)).provider_outcome_unknown, true, "X24"); assert.notEqual(JSON.parse(x.state.get(KEY)).status, "approved", "X24"); }
  finally { x.restore(); }
});

test("X25 ON owner approval revalidates account before any financial POST", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 196 }) });
  try { await x.invoke(); x.env.MERCADOPAGO_ENV = "sandbox"; assert.equal((await x.ownerAction("approve")).status, 503, "X25"); assert.equal(x.calls.post, 0, "X25"); }
  finally { x.restore(); }
});
