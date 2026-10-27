// Re-audit r2 corrections (PR #945): manual review instead of silent drop (M-A), re-evaluation of
// held requests (M-B) and the LOW items. Every external boundary is fake; no credential is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleRefundFlow, runRefundWatchdog } from "../worker/refund-flow.mjs";
import { saveRefund } from "../worker/refund-provider-claims.mjs";
import { idempotentDdl } from "../worker/refund-state.mjs";
import { createRefundStateFake } from "./helpers/refund-state-fake.mjs";

const OID = "11111111-2222-4333-8444-555555555555";
const BUYER = "buyer@example.com";
const OWNER = "owner@example.com";
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
  refundBody = { id: "ref-1", status: "approved", amount: 197 } } = {}) {
  const state = new Map();
  let claim = null;
  const world = { item, paid, delivery, getFails: false, getStatus: 503, staleKey: false, resendGate: null, resendDown: false, kvPutFails: false };
  const calls = { get: 0, post: 0, emails: [] };
  const kv = {
    get: async (k) => (world.staleKey && k === KEY ? null : state.get(k) ?? null),
    put: async (k, v) => { if (world.kvPutFails && k.startsWith("refund:req:")) throw Error("kv write failed"); state.set(k, v); },
    delete: async (k) => { state.delete(k); },
    list: async ({ prefix }) => ({ keys: [...state.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
  const pg = createRefundStateFake();
  const sql = { query: async (statement, args = []) => {
    const authoritative = pg.handle(statement, args);
    if (authoritative !== undefined) return authoritative;
    if (statement.includes("from orders o")) return world.item ? [world.item] : [];
    if (statement.startsWith("select evidence_ref")) return world.delivery ? [{ evidence_ref: JSON.stringify({ email_recipient: world.delivery }) }] : [];
    if (statement.startsWith("select order_id,payment_id,test,stage")) return claim ? [{ ...claim }] : [];
    if (statement.startsWith("insert into refund_provider_claims")) {
      if (claim) return [];
      claim = { order_id: args[0], payment_id: args[1], test: args[2], stage: "provider_call_may_have_been_sent", claimed_at: new Date().toISOString(), reconciled_status: null };
      return [{ order_id: args[0] }];
    }
    if (statement.startsWith("update refund_provider_claims") && statement.includes("reconciled_refunded")) { if (claim) claim.stage = "reconciled_refunded"; return []; }
    return [];
  } };
  const env = { REFUND_AUTO_DISPATCH: flag, MERCADOPAGO_ENV: mode, MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: HASH,
    MERCADOPAGO_ACCESS_TOKEN: "APP_USR-FAKE-PRODUCTION-ABCDEFGHIJKLMNOP", MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-FAKE-SANDBOX",
    RESEND_API_KEY: "fake-resend", OWNER_ALERT_EMAIL: OWNER, ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://fake.invalid/test" };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/users/me")) return Response.json({ id: 123456789, site_id: "MLB", tags: [] });
    if (target === "https://api.resend.com/emails") {
      if (world.resendGate) await world.resendGate;
      const mail = JSON.parse(options.body);
      const down = world.resendDown || (world.failTo && mail.to.includes(world.failTo));
      calls.emails.push({ ...mail, headers: options.headers, ok: !down });
      return down ? new Response("down", { status: 503 }) : Response.json({ id: "fake-email" });
    }
    if (target.includes("api.mercadopago.com") && options.method === "POST") { calls.post++; return Response.json(refundBody); }
    if (target.includes("api.mercadopago.com")) {
      calls.get++;
      if (world.getFails) return new Response("unavailable", { status: world.getStatus });
      return Response.json(world.paid);
    }
    throw new Error("R00 unexpected external endpoint " + target);
  };
  const invoke = async (email = BUYER, ctx) => {
    const r = await handleRefundFlow(new Request("https://zevanory.api.br/api/support/refund-request", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
      body: JSON.stringify({ order_id: OID, email }) }), env, { sqlFactory: () => sql, ctx });
    return { status: r.status, body: await r.json() };
  };
  const panel = async () => (await handleRefundFlow(new Request("https://zevanory.api.br/admin/refunds"), env,
    { sqlFactory: () => sql, isAdminAuthorized: () => true })).text();
  const ownerAction = async (action, { justification = "Verificado com o comprador pelo endereço registrado", evidence = "ticket-123", override = null } = {}) => {
    const r = await handleRefundFlow(new Request("https://zevanory.api.br/admin/refunds/action", {
      method: "POST", body: new URLSearchParams({ order_id: OID, action, justification, evidence, ...(override ? { override } : {}) }) }), env, { sqlFactory: () => sql, isAdminAuthorized: () => true });
    return { status: r.status, text: await r.text() };
  };
  const watchdog = (now = Date.now()) => runRefundWatchdog(env, now, { sqlFactory: () => sql });
  const rec = () => pg.get(OID) || JSON.parse(state.get(KEY) || "null"); // authoritative ON state, else legacy KV
  const to = (who) => calls.emails.filter((e) => e.to.includes(who));
  const customerMails = () => calls.emails.filter((e) => !e.to.includes(OWNER));
  return { state, calls, env, kv, pg, sql, world, invoke, panel, ownerAction, watchdog, rec, to, customerMails, claim: () => claim,
    restore: () => { globalThis.fetch = previousFetch; } };
}

test("R01 conflict (delivery != payer): manual identity review, ack only to the matched delivery address, owner alerted, uniform response", async () => {
  const x = fixture({ paid: payment({ payer: { email: "payer-mp@example.com" } }) });
  try {
    const out = await x.invoke(BUYER);
    assert.deepEqual(Object.keys(out.body).sort(), ["message", "protocol", "received"], "R01 uniform body");
    assert.equal(x.rec()?.manual_reason, "identity_conflict", "R01 manual review opened");
    assert.equal(x.rec()?.identity_verified, false, "R01 identity not verified");
    assert.equal(x.calls.post, 0, "R01 no POST");
    assert.deepEqual(x.customerMails().map((e) => e.to[0]), [BUYER], "R01 ack to matched delivery only");
    assert.match(String(x.customerMails()[0]?.text), /análise manual/, "R01 ack states manual review");
    assert.equal(x.to("payer-mp@example.com").length, 0, "R01 the other party is not contacted");
    assert.ok(x.to(OWNER).some((e) => /identity_conflict/.test(e.text)), "R01 owner alerted");
    const page = await x.panel();
    assert.match(page, /value="approve">Aprovar reembolso/, "R01 owner may approve after manual verification");
    assert.match(page, /value="reject"/, "R01 owner may reject");
  } finally { x.restore(); }
});

test("R02 credential failure + no delivery row: manual review, owner + credential alert, no consumer e-mail, then real payer is refunded automatically", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    const out = await x.invoke(BUYER);
    assert.equal(out.status, 200, "R02 uniform response");
    assert.equal(x.rec()?.manual_reason, "identity_unverifiable", "R02 manual review opened");
    assert.equal(x.customerMails().length, 0, "R02 no e-mail to an unverified typed address");
    assert.ok(x.to(OWNER).some((e) => /análise manual/.test(e.subject)), "R02 owner manual alert");
    assert.ok(x.to(OWNER).some((e) => /credencial incompatível/.test(e.subject)), "R02 credential alert");
    assert.doesNotMatch(await x.panel(), /value="approve">/, "R02 unverifiable cannot be approved");
    x.env.MERCADOPAGO_ENV = "production";
    await x.invoke(BUYER);
    assert.equal(x.calls.post, 1, "R02 real payer refunded once credential recovers");
    assert.equal(x.rec()?.status, "approved", "R02 approved");
  } finally { x.restore(); }
});

test("R03 attacker opens an unverifiable review during an outage: never blocks the real payer (H1) and is moved to audit on re-evaluation", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    await x.invoke("attacker@evil.example");
    assert.equal(x.rec()?.manual_reason, "identity_unverifiable", "R03 review opened");
    assert.equal(x.to("attacker@evil.example").length, 0, "R03 nothing sent to the typed address");
    x.env.MERCADOPAGO_ENV = "production";
    await x.watchdog();
    assert.equal(x.rec()?.status, "unverified_closed", "R03 proven mismatch closed (kept, audited, not actionable)");
    assert.ok(x.pg.events.some((e) => e.to_status === "unverified_closed" && e.actor === "watchdog"), "R03 closure audited");
    assert.ok([...x.state.keys()].some((k) => k.startsWith("refund:unverified:")), "R03 kept as audit entry");
    assert.equal(x.calls.post, 0, "R03 watchdog never POSTs");
    await x.invoke(BUYER);
    assert.equal(x.calls.post, 1, "R03 real payer refunded");
  } finally { x.restore(); }
});

test("R04 unverifiable request by the real payer: watchdog re-evaluation confirms identity, sends the protocol to the payer, owner can approve", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    await x.invoke(BUYER);
    const nonce = x.rec()?.request_nonce;
    x.env.MERCADOPAGO_ENV = "production";
    await x.watchdog();
    assert.equal(x.rec()?.identity_verified, true, "R04 identity confirmed by stored hash");
    assert.equal(x.rec()?.manual_reason, "eligible_after_reevaluation", "R04 ready for owner");
    assert.equal(x.calls.post, 0, "R04 watchdog never POSTs");
    const acks = x.to(BUYER).filter((e) => /recebemos/.test(e.subject));
    assert.equal(acks.length, 1, "R04 protocol now sent to the registered payer");
    assert.ok(nonce && String(acks[0]?.text).includes(nonce), "R04 manifestation identifier in the protocol");
    assert.equal((await x.ownerAction("approve")).status, 303, "R04 owner approval");
    assert.equal(x.calls.post, 1, "R04 single POST");
  } finally { x.restore(); }
});

test("R05 payment_event_missing then late webhook: consumer re-request re-evaluates and dispatches once, keeping the original manifestation", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try {
    await x.invoke();
    const first = x.rec();
    assert.equal(first?.manual_reason, "payment_event_missing", "R05 held");
    Object.assign(x.world.item, { payment_id: "99887766", paid_at: new Date().toISOString() });
    await x.invoke();
    assert.equal(x.calls.post, 1, "R05 dispatched after re-evaluation");
    assert.equal(x.rec()?.status, "approved", "R05 approved");
    assert.equal(x.rec()?.requested_at, first?.requested_at, "R05 original manifestation kept");
    assert.equal(x.rec()?.request_nonce, first?.request_nonce, "R05 same protocol");
    assert.equal(x.to(BUYER).filter((e) => /recebemos/.test(e.subject)).length, 1, "R05 no duplicate protocol e-mail");
  } finally { x.restore(); }
});

test("R06 payment_event_missing then late webhook: watchdog re-evaluates (GET only) and the owner can approve", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try {
    await x.invoke();
    Object.assign(x.world.item, { payment_id: "99887766", paid_at: new Date().toISOString() });
    const wd = await x.watchdog();
    assert.equal(wd.reevaluated, 1, "R06 counted");
    assert.equal(x.rec()?.manual_reason, "eligible_after_reevaluation", "R06 ready");
    assert.equal(x.rec()?.payment_id, "99887766", "R06 payment id filled");
    assert.equal(x.calls.post, 0, "R06 watchdog never POSTs");
    assert.match(await x.panel(), /value="approve">Aprovar reembolso/, "R06 approve button");
    assert.equal((await x.ownerAction("approve")).status, 303, "R06 approve");
    assert.equal(x.calls.post, 1, "R06 one POST");
  } finally { x.restore(); }
});

test("R07 payment_event_missing still missing: no approve button, Reject and Reavaliar available, approve is refused, reject works", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try {
    await x.invoke();
    const page = await x.panel();
    assert.doesNotMatch(page, /value="approve">/, "R07 no approve");
    assert.match(page, /value="reevaluate">Reavaliar agora/, "R07 reevaluate");
    assert.match(page, /value="reject" class="no">Recusar/, "R07 reject");
    assert.equal((await x.ownerAction("reevaluate")).status, 303, "R07 reevaluate ok");
    assert.equal((await x.ownerAction("approve")).status, 409, "R07 approve refused without evidence");
    assert.equal((await x.ownerAction("reject")).status, 303, "R07 reject ok");
    assert.equal(x.rec()?.status, "rejected", "R07 rejected");
    assert.equal(x.calls.post, 0, "R07 no POST");
  } finally { x.restore(); }
});

test("R08 owner approve on a held request after the webhook arrived re-evaluates first instead of a 409 dead end", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try {
    await x.invoke();
    Object.assign(x.world.item, { payment_id: "99887766", paid_at: new Date().toISOString() });
    assert.equal((await x.ownerAction("approve")).status, 303, "R08 approve succeeds");
    assert.equal(x.calls.post, 1, "R08 one POST");
    assert.equal(x.rec()?.status, "approved", "R08 approved");
  } finally { x.restore(); }
});

test("R09 transient payment lookup failure is provider_lookup_failed (not payment_not_approved) and recovers on re-request", async () => {
  const x = fixture();
  try {
    x.world.getFails = true;
    await x.invoke();
    assert.equal(x.rec()?.manual_reason, "provider_lookup_failed", "R09 distinct reason");
    assert.equal(x.calls.post, 0, "R09 no POST");
    x.world.getFails = false;
    await x.invoke();
    assert.equal(x.calls.post, 1, "R09 dispatched once provider recovers");
  } finally { x.restore(); }
});

test("R10 unconfirmed attempts are bounded per order and deduplicated per address", async () => {
  const x = fixture();
  try {
    for (let i = 0; i < 30; i++) await x.invoke(`a${i}@evil.example`);
    for (let i = 0; i < 5; i++) await x.invoke("same@evil.example");
    const keys = [...x.state.keys()].filter((k) => k.startsWith("refund:unverified:"));
    assert.equal(keys.length, 10, "R10 capped at 10");
    assert.equal(JSON.parse(x.state.get(`refund:unverified-overflow:${OID}`) || "null")?.attempts, 25, "R10 attempts beyond the cap are still counted");
    assert.match(await x.panel(), /excedente do limite: 25 tentativas/, "R10 overflow visible to the owner");
    await x.invoke(BUYER);
    assert.equal(x.calls.post, 1, "R10 buyer unaffected");
    const y = fixture();
    try {
      for (let i = 0; i < 4; i++) await y.invoke("same@evil.example");
      const k = [...y.state.keys()].filter((n) => n.startsWith("refund:unverified:"));
      assert.equal(k.length, 1, "R10 one key per address");
      assert.equal(JSON.parse(y.state.get(k[0])).attempts, 4, "R10 attempts counted");
    } finally { y.restore(); }
  } finally { x.restore(); }
});

test("R11 provider-confirmed approved state wins over a newer concurrent pending copy and keeps its delivered markers", async () => {
  const x = fixture();
  try {
    const base = { order_id: OID, auto_dispatch: true, request_nonce: "n1" };
    assert.equal(await saveRefund(x.kv, { ...base, status: "pending", version: 0, customer_email_pending: true }, { sql: x.sql }), true, "R11 created");
    assert.equal(await saveRefund(x.kv, { ...base, status: "pending", version: 1, customer_email_pending: true }, { sql: x.sql }), true, "R11 v2");
    assert.equal(await saveRefund(x.kv, { ...base, status: "pending", version: 2, customer_email_pending: false }, { sql: x.sql }), true, "R11 concurrent writer v3");
    const ok = await saveRefund(x.kv, { ...base, status: "approved", version: 1, customer_email_pending: true }, { sql: x.sql, actor: "automatic-withdrawal" });
    assert.equal(ok, true, "R11 terminal write accepted");
    const r = x.pg.get(OID);
    assert.equal(r?.status, "approved", "R11 approved kept");
    assert.equal(r?.version, 4, "R11 version advanced");
    assert.equal(r?.customer_email_pending, false, "R11 delivered marker merged");
    assert.equal(await saveRefund(x.kv, { ...base, status: "pending", version: 9 }, { sql: x.sql }), false, "R11 pending never overwrites approved");
    assert.equal(await saveRefund(x.kv, { ...base, status: "pending", version: 4 }, { sql: x.sql }), false, "R11 pending never overwrites approved at the same version");
    assert.equal(await saveRefund(x.kv, { ...base, status: "pending", version: 0 }), false, "R11 no ON write without the authoritative store");
    assert.deepEqual(x.pg.events.map((e) => e.version), [1, 2, 3, 4], "R11 one audited event per transition");
  } finally { x.restore(); }
});

test("R12 stale empty read of an indexed manual request mints no second protocol, alert or nonce", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    const first = x.rec(), mails = x.calls.emails.length;
    x.world.staleKey = true;
    await x.invoke();
    x.world.staleKey = false;
    assert.equal(x.rec()?.request_nonce, first?.request_nonce, "R12 not overwritten");
    assert.equal(x.calls.emails.length, mails, "R12 no duplicate e-mail");
  } finally { x.restore(); }
});

test("R13 automatic dispatch notifies the owner that no manual approval is requested (F07)", async () => {
  const x = fixture();
  try {
    await x.invoke();
    const note = x.to(OWNER).find((e) => e.subject === "ZEVANORY — despacho automático de reembolso");
    assert.equal(note?.text, `Pedido ${OID}: resultado approved. Esta é uma notificação; não foi solicitada aprovação manual.`, "R13 exact notification");
  } finally { x.restore(); }
});

test("R14 OFF owner approval rejects a provider refund amount that differs from the order (F13b)", async () => {
  const x = fixture({ flag: "false", refundBody: { id: "ref-1", status: "approved", amount: 150 } });
  try {
    assert.equal((await x.invoke()).status, 200, "R14 legacy request");
    const out = await x.ownerAction("approve");
    assert.equal(out.status, 502, "R14 refused");
    assert.notEqual(x.rec()?.status, "approved", "R14 never approved");
    assert.equal(x.rec()?.provider_outcome_unknown, true, "R14 flagged for reconciliation");
  } finally { x.restore(); }
});

test("R15 OFF admin page keeps the legacy markup; ON-only markup appears only with ON-created state (L-7)", async () => {
  const x = fixture({ flag: "false" });
  try {
    await x.invoke();
    const page = await x.panel();
    assert.doesNotMatch(page, /<small>há /, "R15 no age line while OFF");
    assert.doesNotMatch(page, /Tentativas com identidade não confirmada/, "R15 no audit section while OFF");
    assert.match(page, /value="approve">Aprovar reembolso/, "R15 legacy action kept");
    assert.equal((await x.ownerAction("reevaluate")).status, 400, "R15 legacy invalid action unchanged");
    x.env.REFUND_AUTO_DISPATCH = "true";
    assert.match(await x.panel(), /Tentativas com identidade não confirmada/, "R15 ON page");
  } finally { x.restore(); }
});

test("R16 owner rejecting an unconfirmed review does not turn the real payer's request into previously_rejected", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    await x.invoke("attacker@evil.example");
    assert.equal((await x.ownerAction("reject")).status, 303, "R16 owner rejects");
    x.env.MERCADOPAGO_ENV = "production";
    await x.invoke(BUYER);
    assert.notEqual(x.rec()?.manual_reason, "previously_rejected", "R16 not sticky");
    assert.equal(x.calls.post, 1, "R16 real payer refunded");
    assert.equal(x.rec()?.history.length, 1, "R16 rejection history kept");
  } finally { x.restore(); }
});

test("R17 with waitUntil, the uniform response never waits for e-mails or the provider POST (timing, L-1)", async () => {
  const x = fixture();
  const pending = [];
  let release;
  x.world.resendGate = new Promise((r) => { release = r; });
  try {
    const call = x.invoke(BUYER, { waitUntil: (p) => pending.push(p) });
    pending.push(call);
    const out = await Promise.race([call, new Promise((r) => setTimeout(() => r(null), 1500))]);
    assert.equal(out?.status, 200, "R17 response returned while e-mail delivery is blocked");
    assert.equal(x.calls.emails.length, 0, "R17 no e-mail completed before response");
    assert.equal(x.calls.post, 0, "R17 no POST before response");
    assert.equal(x.rec()?.status, "pending", "R17 request registered before response");
    release();
    await Promise.all(pending);
    assert.equal(x.calls.post, 1, "R17 dispatched after response");
    assert.ok(x.to(BUYER).length >= 1, "R17 protocol sent after response");
  } finally { release(); await Promise.allSettled(pending); x.restore(); }
});

test("R18 stale empty read inside the background dispatch uses the in-memory record (single POST)", async () => {
  const x = fixture();
  try {
    let stale = true;
    const get = x.kv.get;
    x.kv.get = async (k) => { if (k === KEY && stale && /executeRefund/.test(new Error().stack)) { stale = false; return null; } return get(k); };
    await x.invoke();
    assert.equal(stale, false, "R18 stale read injected");
    assert.equal(x.calls.post, 1, "R18 dispatched");
  } finally { x.restore(); }
});

test("R19 re-evaluation measures the withdrawal window at the original manifestation, not at re-evaluation time", async () => {
  const late = { delivered_at: new Date(Date.now() - 12 * DAY).toISOString() };
  for (const via of ["request", "watchdog"]) {
    const x = fixture({ item: order({ payment_id: null, paid_at: null, ...late }) });
    try {
      await x.invoke();
      const r = x.rec();
      assert.ok(r, "R19 held request registered (" + via + ")");
      x.pg.set(OID, { ...r, requested_at: new Date(Date.now() - 6 * DAY).toISOString() }); // manifested inside the window (and inside the 7-day re-evaluation window)
      Object.assign(x.world.item, { payment_id: "99887766", paid_at: new Date(Date.now() - 12 * DAY).toISOString() });
      if (via === "request") await x.invoke(); else await x.watchdog();
      assert.notEqual(x.rec()?.manual_reason, "outside_withdrawal_window", "R19 window kept (" + via + ")");
      assert.equal(x.rec()?.auto_eligible, true, "R19 eligible at manifestation (" + via + ")");
    } finally { x.restore(); }
  }
});

// ---- Coordinator/auditor ORDEM 294: decision state in PostgreSQL, KV only a cache ----

test("R20 a human decision on a manual-review request requires a justification, recorded with owner and system evidence", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    assert.equal((await x.ownerAction("approve", { justification: "" })).status, 400, "R20 approve without justification refused");
    assert.equal((await x.ownerAction("reject", { justification: "curta" })).status, 400, "R20 reject with a too-short justification refused");
    assert.equal(x.calls.post, 0, "R20 no POST");
    assert.equal(x.claim(), null, "R20 no reservation");
    assert.equal((await x.ownerAction("approve", { justification: "Valor conferido manualmente no painel do provedor", evidence: "MP 99887766" })).status, 303, "R20 approve with justification");
    const decision = x.pg.events.find((e) => e.transition_key?.startsWith("owner:approve:"));
    assert.equal(decision?.actor, "owner", "R20 decision actor");
    assert.equal(decision?.justification, "Valor conferido manualmente no painel do provedor", "R20 justification recorded");
    assert.equal(decision?.evidence?.owner, "MP 99887766", "R20 owner evidence recorded");
    assert.equal(decision?.evidence?.manual_reason, "payment_amount_mismatch", "R20 system evidence recorded");
    assert.ok(x.pg.events.indexOf(decision) < x.pg.events.findIndex((e) => e.to_status === "approved"), "R20 decision persisted before the outcome");
  } finally { x.restore(); }
});

test("R21 payment_event_missing lifecycle is fully audited: request, re-evaluation, owner decision, provider outcome", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try {
    await x.invoke();
    Object.assign(x.world.item, { payment_id: "99887766", paid_at: new Date().toISOString() });
    await x.watchdog();
    await x.ownerAction("approve");
    const first = (pred) => x.pg.events.findIndex(pred);
    const order = [first((e) => e.actor === "consumer-request"), first((e) => e.actor === "watchdog"),
      first((e) => e.transition_key?.startsWith("owner:approve:")), first((e) => e.to_status === "approved")];
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), "R21 request -> re-evaluation -> owner decision -> outcome: " + order);
    assert.equal(x.pg.events[0].manual_reason, "payment_event_missing", "R21 creation reason");
    assert.equal(x.pg.events.find((e) => e.actor === "watchdog")?.manual_reason, "eligible_after_reevaluation", "R21 re-evaluation recorded");
    assert.equal(x.pg.get(OID).status, "approved", "R21 outcome");
    assert.equal(new Set(x.pg.events.map((e) => e.version)).size, x.pg.events.length, "R21 one event per version");
    assert.equal(x.calls.post, 1, "R21 single POST");
  } finally { x.restore(); }
});

test("R22 provider errors are classified: 404 is definitive (held, not auto re-evaluated), 503 is transient (re-evaluated)", async () => {
  const x = fixture();
  try {
    x.world.getFails = true; x.world.getStatus = 404;
    await x.invoke();
    assert.equal(x.rec()?.manual_reason, "provider_payment_not_found", "R22 definitive reason");
    const gets = x.calls.get;
    await x.watchdog();
    assert.equal(x.calls.get, gets, "R22 watchdog does not re-query a definitive answer");
    assert.doesNotMatch(await x.panel(), /value="approve">/, "R22 cannot approve a payment the provider does not know");
    x.world.getFails = false;
    assert.equal((await x.ownerAction("reevaluate")).status, 303, "R22 owner can re-evaluate on demand");
    assert.equal(x.rec()?.manual_reason, "eligible_after_reevaluation", "R22 recovered on demand");
  } finally { x.restore(); }
  const y = fixture();
  try {
    y.world.getFails = true; y.world.getStatus = 503;
    await y.invoke();
    assert.equal(y.rec()?.manual_reason, "provider_lookup_failed", "R22 transient reason");
    y.world.getFails = false;
    await y.watchdog();
    assert.equal(y.rec()?.manual_reason, "eligible_after_reevaluation", "R22 transient re-evaluated by watchdog");
    assert.equal(y.calls.post, 0, "R22 watchdog never POSTs");
  } finally { y.restore(); }
});

test("R23 automatic re-evaluation is bounded: after 7 days the watchdog stops re-querying and alerts the owner once", async () => {
  const x = fixture({ item: order({ payment_id: null, paid_at: null }) });
  try {
    await x.invoke();
    x.pg.set(OID, { ...x.rec(), requested_at: new Date(Date.now() - 8 * DAY).toISOString() });
    const gets = x.calls.get;
    await x.watchdog();
    await x.watchdog();
    assert.equal(x.calls.get, gets, "R23 no provider query after the window");
    assert.equal(x.rec()?.reevaluation_closed, true, "R23 flagged");
    assert.equal(x.to(OWNER).filter((e) => /reavaliação automática encerrada/.test(e.subject)).length, 1, "R23 one owner alert");
    assert.match(await x.panel(), /value="reject"/, "R23 owner can still decide");
  } finally { x.restore(); }
});

test("R24 failure between the provider confirmation and its persistence is recovered by GET reconciliation without a second POST", async () => {
  const x = fixture();
  try {
    const q = x.sql.query; let failed = false;
    x.sql.query = async (statement, args) => {
      if (!failed && statement.startsWith("with prev as") && args[2] === "approved") { failed = true; throw Error("crash before persisting approved"); }
      return q(statement, args);
    };
    await x.invoke();
    assert.equal(failed, true, "R24 failure injected");
    assert.equal(x.calls.post, 1, "R24 provider called once");
    assert.notEqual(x.rec()?.status, "approved", "R24 not yet persisted");
    x.world.paid = payment({ transaction_amount_refunded: 197, refunds: [{ id: "ref-1", amount: 197, status: "approved" }] });
    await x.watchdog();
    assert.equal(x.rec()?.status, "approved", "R24 recovered by reconciliation");
    await x.invoke();
    assert.equal((await x.ownerAction("approve")).status, 303, "R24 owner approve is a duplicate no-op");
    assert.equal(x.calls.post, 1, "R24 never a second POST");
  } finally { x.restore(); }
});

test("R25 concurrent owner approvals and consumer re-requests produce a single provider refund", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    await Promise.all([x.ownerAction("approve"), x.ownerAction("approve"), x.invoke(), x.ownerAction("approve")]);
    assert.equal(x.calls.post, 1, "R25 one POST");
    assert.equal(x.rec()?.status, "approved", "R25 approved");
  } finally { x.restore(); }
});

test("R26 rejection is communicated only through the registered address; without a secure channel it is flagged, not sent", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    assert.equal((await x.ownerAction("reject")).status, 303, "R26 reject");
    const decision = x.calls.emails.filter((e) => /decisão sobre seu pedido/.test(e.subject));
    assert.deepEqual(decision.map((e) => e.to[0]), [BUYER], "R26 decision to the registered address");
    assert.equal(x.rec()?.decision_email_pending, false, "R26 delivered");
  } finally { x.restore(); }
  const y = fixture({ mode: "sandbox", delivery: "" });
  try {
    await y.invoke("someone@example.org");
    assert.equal(y.rec()?.confirmation_channel, "none", "R26 no secure channel flagged");
    assert.match(await y.panel(), /sem canal seguro de confirmação/, "R26 flag visible to the owner");
    await y.ownerAction("reject");
    assert.equal(y.customerMails().length, 0, "R26 nothing sent to an unproven address");
    assert.equal(y.rec()?.status, "rejected", "R26 decision tracked");
  } finally { y.restore(); }
});

test("R27 a consumer confirmation that keeps failing alerts the owner once after 24 h and keeps retrying", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    x.world.failTo = BUYER; // the consumer mailbox rejects; the owner channel works
    await x.invoke();
    assert.equal(x.rec()?.customer_email_pending, true, "R27 pending");
    await x.watchdog(Date.now() + 2 * 3600e3);
    assert.equal(x.to(OWNER).filter((e) => /confirmação ao consumidor não entregue/.test(e.subject)).length, 0, "R27 no alert before 24 h");
    await x.watchdog(Date.now() + 25 * 3600e3);
    await x.watchdog(Date.now() + 26 * 3600e3);
    assert.equal(x.to(OWNER).filter((e) => /confirmação ao consumidor não entregue/.test(e.subject)).length, 1, "R27 single owner alert");
    assert.equal(x.rec()?.confirmation_failure_alerted, true, "R27 alert tracked");
    x.world.failTo = null;
    await x.watchdog(Date.now() + 27 * 3600e3);
    assert.equal(x.rec()?.customer_email_pending, false, "R27 eventually delivered");
  } finally { x.restore(); }
});

test("R28 stale KV reads (old copy or empty) never change a decision: no second POST, no regression, no new protocol", async () => {
  const x = fixture();
  try {
    await x.invoke();
    const stalePending = JSON.stringify({ ...x.rec(), status: "pending", version: 1, refund_id: null });
    const get = x.kv.get;
    for (const stale of [stalePending, null]) {
      x.kv.get = async (k) => (k === KEY ? stale : get(k));
      await x.invoke();
      assert.equal((await x.ownerAction("approve")).status, 303, "R28 approve is a duplicate no-op");
      await x.watchdog();
      assert.equal(x.calls.post, 1, "R28 single POST");
      assert.equal(x.pg.get(OID)?.status, "approved", "R28 authoritative state unchanged");
    }
    x.kv.get = get;
    assert.equal(x.to(BUYER).filter((e) => /recebemos/.test(e.subject)).length, 1, "R28 no duplicate protocol");
  } finally { x.restore(); }
});

test("R29 failed KV writes never lose or corrupt the business state", async () => {
  const x = fixture();
  try {
    x.world.kvPutFails = true;
    assert.equal((await x.invoke()).status, 200, "R29 uniform response");
    assert.equal(x.calls.post, 1, "R29 dispatched once");
    assert.equal(x.pg.get(OID)?.status, "approved", "R29 approved in PostgreSQL");
    assert.equal(x.state.has(KEY), false, "R29 KV copy missing");
    assert.match(await x.panel(), new RegExp(OID), "R29 owner still sees the request");
    await x.invoke();
    assert.equal(x.calls.post, 1, "R29 no second POST");
  } finally { x.restore(); }
  const y = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    y.world.kvPutFails = true;
    await y.invoke();
    assert.equal((await y.ownerAction("reject")).status, 303, "R29 reject persisted without KV");
    y.state.delete(KEY);
    y.world.kvPutFails = false;
    await y.invoke();
    assert.equal(y.rec()?.manual_reason, "previously_rejected", "R29 rejection survives a KV wipe");
    assert.equal(y.calls.post, 0, "R29 no POST after rejection");
  } finally { y.restore(); }
});

test("R30 a KV copy forged or rolled back by hand is ignored for ON decisions", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    x.state.set(KEY, JSON.stringify({ ...x.rec(), auto_eligible: true, manual_reason: null, identity_verified: true }));
    await x.invoke();
    assert.equal(x.calls.post, 0, "R30 forged KV copy cannot trigger a refund");
    assert.equal(x.rec()?.manual_reason, "payment_amount_mismatch", "R30 authoritative reason kept");
  } finally { x.restore(); }
});

test("R31 PostgreSQL state unavailable: no ON write, the consumer gets the retry message, the owner sees and is alerted", async () => {
  const x = fixture();
  try {
    x.pg.down = true;
    const out = await x.invoke();
    assert.equal(out.status, 503, "R31 not silently accepted");
    assert.match(out.body.message, /Tente novamente/, "R31 retry message");
    assert.equal(x.calls.post, 0, "R31 no POST");
    assert.match(await x.panel(), /Estado autoritativo \(PostgreSQL\) indisponível/, "R31 owner banner");
    const wd = await x.watchdog();
    assert.equal(wd.ok, false, "R31 watchdog red");
    assert.ok(x.to(OWNER).some((e) => /estado de reembolso indisponível/.test(e.subject)), "R31 owner alerted");
    x.pg.down = false;
    await x.invoke();
    assert.equal(x.calls.post, 1, "R31 processed after recovery");
  } finally { x.restore(); }
});

test("R32 the response never exposes registered or payer data, whatever the identity outcome", async () => {
  const outs = [];
  for (const [opts, email] of [[{ paid: payment({ payer: { email: "payer-mp@example.com" } }) }, BUYER], [{ mode: "sandbox", delivery: "" }, BUYER], [{}, "intruder@example.net"], [{}, BUYER]]) {
    const x = fixture(opts);
    try { outs.push(JSON.stringify(await x.invoke(email))); } finally { x.restore(); }
  }
  assert.equal(new Set(outs).size, 1, "R32 identical responses");
  assert.doesNotMatch(outs[0], /@|payer|buyer|\*\*\*/, "R32 no address fragment");
});

test("R33 a decided-eligible request interrupted before the reservation is recovered by a re-request with a single POST", async () => {
  const x = fixture();
  try {
    const q = x.sql.query; let failOnce = true;
    x.sql.query = async (statement, args) => {
      if (failOnce && statement.startsWith("insert into refund_provider_claims")) { failOnce = false; throw Error("restart before reservation"); }
      return q(statement, args);
    };
    await x.invoke();
    assert.equal(x.calls.post, 0, "R33 interrupted before the reservation");
    assert.equal(x.rec()?.auto_eligible, true, "R33 decision recorded");
    await x.invoke();
    assert.equal(x.calls.post, 1, "R33 recovered with one POST");
    await x.invoke();
    assert.equal(x.calls.post, 1, "R33 no further POST");
    assert.equal(x.rec()?.status, "approved", "R33 approved");
  } finally { x.restore(); }
});

test("R34 after an emergency switch-off, ON records are still decided from PostgreSQL and a KV copy is ignored", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    x.state.set(KEY, JSON.stringify({ ...x.rec(), status: "rejected" }));
    x.env.REFUND_AUTO_DISPATCH = "false";
    assert.equal((await x.ownerAction("approve")).status, 303, "R34 owner decision from the authoritative pending state");
    assert.equal(x.calls.post, 1, "R34 one POST");
    assert.equal(x.pg.get(OID)?.status, "approved", "R34 approved in PostgreSQL");
    assert.match(await x.panel(), /Pedidos de reembolso/, "R34 panel renders");
  } finally { x.restore(); }
});

// ---- Round 3 LOWs (auditor r3 + Sol: a manifestation never disappears) ----

test("R35 losing the compare-and-swap re-reads and re-decides: the real buyer is never dropped; exhausted retries answer 503 and alert", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    await x.invoke("attacker@evil.example"); // unconfirmed review (credential failure)
    x.env.MERCADOPAGO_ENV = "production";
    const q = x.sql.query; let fired = false;
    x.sql.query = async (statement, args) => {
      if (!fired && statement.startsWith("with prev as")) {
        fired = true; // a concurrent writer bumps the version between the buyer's read and CAS
        const r = x.pg.get(OID); x.pg.set(OID, { ...r, version: r.version + 1, identity_hashes: [...r.identity_hashes, "concurrent"] });
      }
      return q(statement, args);
    };
    await x.invoke(BUYER);
    x.sql.query = q;
    assert.equal(fired, true, "R35 interleaving injected");
    assert.equal(x.rec()?.identity_verified, true, "R35 buyer request recorded after re-decision");
    assert.equal(x.calls.post, 1, "R35 buyer refunded");
  } finally { x.restore(); }
  const y = fixture();
  try {
    const q = y.sql.query;
    y.sql.query = async (statement, args) => (statement.startsWith("with ins as") ? [] : q(statement, args)); // every CAS lost
    const out = await y.invoke(BUYER);
    assert.equal(out.status, 503, "R35 never a receipt without a record");
    assert.ok(y.to(OWNER).some((e) => /não registrado \(concorrência\)/.test(e.subject)), "R35 owner alerted");
    assert.equal(y.calls.post, 0, "R35 no POST");
  } finally { y.restore(); }
});

test("R36 KV unavailable for the sandbox marker: the request is registered in PostgreSQL, fails closed and recovers when KV returns", async () => {
  const x = fixture();
  try {
    const get = x.kv.get;
    x.kv.get = async (k) => { if (k.startsWith("sandbox-proof-v2:")) throw Error("kv down"); return get(k); };
    const out = await x.invoke();
    assert.equal(out.status, 200, "R36 not a 503");
    assert.equal(x.rec()?.manual_reason, "test_flag_unverifiable", "R36 clear fail-closed state");
    assert.equal(x.calls.post, 0, "R36 no automatic POST while the test flag is unknown");
    assert.doesNotMatch(await x.panel(), /value="approve">/, "R36 held");
    x.kv.get = get;
    await x.watchdog();
    assert.equal(x.rec()?.manual_reason, "eligible_after_reevaluation", "R36 recovered by re-evaluation");
  } finally { x.restore(); }
});

test("R37 concurrent first-use DDL is idempotent: a catalog race is tolerated when the table exists, re-raised otherwise", async () => {
  const race = Object.assign(Error("duplicate key value violates unique constraint \"pg_type_typname_nsp_index\""), { code: "23505" });
  const exists = { query: async (s) => { if (s.startsWith("create table")) throw race; return [{ t: "refund_requests" }]; } };
  await assert.doesNotReject(idempotentDdl(exists, "create table if not exists refund_requests ()", "refund_requests"), "R37 race tolerated when the table exists");
  const missing = { query: async (s) => { if (s.startsWith("create table")) throw race; return [{ t: null }]; } };
  await assert.rejects(idempotentDdl(missing, "create table if not exists refund_requests ()", "refund_requests"), /pg_type/, "R37 real failure re-raised");
});

test("R38 OFF without ON-created state never touches the new tables; after ON state exists the OFF panel still lists it", async () => {
  const x = fixture({ flag: "false" });
  try {
    const seen = []; const q = x.sql.query;
    x.sql.query = async (statement, args) => { seen.push(statement); return q(statement, args); };
    await x.invoke(); await x.panel(); await x.ownerAction("approve"); await x.watchdog();
    assert.equal(seen.filter((t) => /refund_request/.test(t)).length, 0, "R38 OFF: no statement on refund_requests/events");
  } finally { x.restore(); }
  const y = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await y.invoke();
    y.state.delete(KEY); // even without the KV copy
    y.env.REFUND_AUTO_DISPATCH = "false";
    assert.match(await y.panel(), new RegExp(OID), "R38 ON record still visible while OFF");
  } finally { y.restore(); }
});

test("R39 an owner rejection of an identity_conflict review is final for that requester; new evidence reopens it to the owner", async () => {
  const x = fixture({ paid: payment({ payer: { email: "payer-mp@example.com" } }) });
  try {
    await x.invoke(BUYER);
    assert.equal((await x.ownerAction("reject")).status, 303, "R39 rejected");
    const mails = x.calls.emails.length, version = x.rec()?.version;
    await x.invoke(BUYER);
    assert.equal(x.rec()?.status, "rejected", "R39 not reopened");
    assert.equal(x.rec()?.version, version + 1, "R39 the manifestation is still recorded");
    assert.equal(x.pg.events.at(-1)?.evidence?.manifestation, true, "R39 audited as a manifestation");
    assert.equal(x.calls.emails.length, mails, "R39 no new protocol or alert");
    x.world.paid = payment(); // registered data now agree (new evidence)
    await x.invoke(BUYER);
    assert.equal(x.rec()?.manual_reason, "previously_rejected", "R39 reopened only for the owner");
    assert.equal(x.calls.post, 0, "R39 never automatic after a rejection");
  } finally { x.restore(); }
});

test("R40 approval without provider proof of payment needs an explicit override with evidence, recorded", async () => {
  const x = fixture();
  try {
    x.world.getFails = true; x.world.getStatus = 401;
    await x.invoke();
    assert.equal(x.rec()?.manual_reason, "provider_lookup_rejected", "R40 definitive lookup failure");
    assert.match(await x.panel(), /name="override" value="1"/, "R40 override checkbox shown");
    assert.equal((await x.ownerAction("approve")).status, 400, "R40 justification alone is not enough");
    assert.equal((await x.ownerAction("approve", { override: "1", evidence: "curta" })).status, 400, "R40 override needs evidence");
    assert.equal(x.calls.post, 0, "R40 no POST");
    assert.equal((await x.ownerAction("approve", { override: "1", evidence: "Comprovante PIX conferido no extrato" })).status, 303, "R40 explicit exception");
    assert.equal(x.calls.post, 1, "R40 one POST");
    const ev = x.pg.events.find((e) => e.transition_key?.startsWith("owner:approve:"));
    assert.equal(ev?.evidence?.payment_override, true, "R40 override recorded");
  } finally { x.restore(); }
  const y = fixture();
  try {
    y.world.getFails = true; y.world.getStatus = 503;
    await y.invoke();
    y.world.getFails = false; // provider recovered: approval re-evaluates first, no override needed
    assert.equal((await y.ownerAction("approve")).status, 303, "R40 recovered provider approves normally");
    assert.equal(y.calls.post, 1, "R40 single POST");
  } finally { y.restore(); }
});

// ---- Round 4 (M-1, M-2, B-1, B-2) ----

test("R41 every manifestation is persisted: after the proof slots are full the real payer is still recorded and matched on re-evaluation", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    for (let i = 0; i < 5; i++) await x.invoke(`g${i}@evil.example`);
    assert.equal(x.rec()?.identity_hashes?.length, 5, "R41 proof slots full");
    const before = x.pg.events.length;
    assert.equal((await x.invoke(BUYER)).status, 200, "R41 receipt");
    assert.equal(x.pg.events.length, before + 1, "R41 the 6th manifestation is a persisted event");
    assert.equal(x.pg.events.at(-1)?.evidence?.proof_overflow, true, "R41 overflow recorded");
    assert.ok(x.to(OWNER).some((e) => /muitas manifestações não confirmadas/.test(e.subject)), "R41 owner alerted on overflow");
    x.env.MERCADOPAGO_ENV = "production";
    await x.watchdog();
    assert.equal(x.rec()?.identity_verified, true, "R41 payer matched from the event log, never closed as unverified");
    assert.notEqual(x.rec()?.status, "unverified_closed", "R41 not closed");
  } finally { x.restore(); }
});

test("R42 emergency OFF without any KV marker or copy: the watchdog still reconciles the ambiguous ON refund and the owner still sees it", async () => {
  const x = fixture({ refundBody: { message: "timeout" } });
  try {
    await x.invoke();
    assert.equal(x.rec()?.provider_outcome_unknown, true, "R42 ambiguous ON refund");
    for (const k of [...x.state.keys()]) if (k.startsWith("refund:")) x.state.delete(k); // KV lost entirely
    x.env.REFUND_AUTO_DISPATCH = "false";
    assert.match(await x.panel(), new RegExp(OID), "R42 owner still sees the ON record");
    x.world.paid = payment({ transaction_amount_refunded: 197, refunds: [{ id: "ref-1", amount: 197, status: "approved" }] });
    const q = x.sql.query;
    x.sql.query = async (s, a) => { if (s.startsWith("select order_id,payment_id,test,stage")) { const r = await q(s, a); return r.map((c) => ({ ...c, claimed_at: new Date(Date.now() - 3600e3).toISOString() })); } return q(s, a); };
    await x.watchdog();
    assert.equal(x.rec()?.status, "approved", "R42 reconciled while OFF");
    assert.equal(x.calls.post, 1, "R42 no second POST");
  } finally { x.restore(); }
});

test("R43 an identity proof that loses the compare-and-swap is retried, never dropped (L1c)", async () => {
  const x = fixture({ mode: "sandbox", delivery: "" });
  try {
    await x.invoke("first@evil.example");
    const q = x.sql.query; let bumped = false;
    x.sql.query = async (s, a) => {
      if (!bumped && s.startsWith("with prev as")) { bumped = true; const r = x.pg.get(OID); x.pg.set(OID, { ...r, version: r.version + 1 }); }
      return q(s, a);
    };
    await x.invoke(BUYER);
    x.sql.query = q;
    assert.equal(bumped, true, "R43 CAS loss injected");
    assert.equal(x.rec()?.identity_hashes?.length, 2, "R43 proof kept after the retry");
  } finally { x.restore(); }
});

test("R44 a storage exception during an owner action is a handled 503 with the state unchanged (B-1)", async () => {
  const x = fixture({ paid: payment({ transaction_amount: 1 }) });
  try {
    await x.invoke();
    const before = x.rec();
    const q = x.sql.query;
    x.sql.query = async (s, a) => { if (s.startsWith("with prev as")) throw Error('relation "refund_request_events" does not exist'); return q(s, a); };
    let out;
    try { out = await x.ownerAction("reject"); } catch { out = { status: "unhandled exception" }; }
    x.sql.query = q;
    assert.equal(out.status, 503, "R44 handled 503");
    assert.equal(x.rec()?.status, before.status, "R44 state unchanged");
    assert.equal(x.rec()?.version, before.version, "R44 version unchanged");
  } finally { x.restore(); }
});
