import test from "node:test";
import assert from "node:assert/strict";
import { handleRefundFlow } from "../worker/refund-flow.mjs";
import { evaluateAutomaticRefund, refundAutoDispatchEnabled, validateMercadoPagoCredential } from "../worker/refund-auto-dispatch.mjs";

const OID = "11111111-2222-4333-8444-555555555555";
const EMAIL = "buyer@example.com";
const PAYMENT_ID = "99887766";
const KEY = "refund:req:" + OID;
const DAY = 86_400_000;

const baseOrder = (extra = {}) => ({ order_id: OID, status: "paid", amount: 197, offer_id: "ZEV-IA-011",
  certification_pilot: false, payment_id: PAYMENT_ID, paid_at: new Date(Date.now() - DAY).toISOString(),
  delivered_at: new Date(Date.now() - DAY).toISOString(), first_download_at: null, ...extra });
const basePayment = (extra = {}) => ({ id: Number(PAYMENT_ID), status: "approved", status_detail: "accredited",
  external_reference: OID, transaction_amount: 197, transaction_amount_refunded: 0, refunds: [], payer: { email: EMAIL },
  metadata: { zevanory_order_id: OID, offer_id: "ZEV-IA-011" }, ...extra });

function fixture({ order = baseOrder(), payment = basePayment(), flag = "true", token = "APP_USR-FAKE-PRODUCTION",
  evidenceEmail = EMAIL, failAfterRecord = false } = {}) {
  const state = new Map();
  let claim = null, recordFailure = failAfterRecord, revocations = 0;
  const calls = { get: 0, post: 0, emails: [] };
  const kv = {
    get: async (k) => state.get(k) ?? null,
    put: async (k, v) => { state.set(k, v); if (k === KEY && recordFailure) { recordFailure = false; throw Error("simulated_worker_restart"); } },
    list: async () => ({ keys: [...state.keys()].map((name) => ({ name })), list_complete: true }),
  };
  const sql = { query: async (statement, args = []) => {
    if (statement.includes("from orders o")) return [order];
    if (statement.startsWith("select evidence_ref")) return evidenceEmail == null ? [] : [{ evidence_ref: JSON.stringify({ email_recipient: evidenceEmail }) }];
    if (statement.startsWith("create table if not exists refund_provider_claims")) return [];
    if (statement.startsWith("select order_id,payment_id,test,stage")) return claim ? [{ ...claim }] : [];
    if (statement.startsWith("insert into refund_provider_claims")) {
      if (claim) return [];
      claim = { order_id: args[0], payment_id: args[1], test: args[2], stage: "provider_call_may_have_been_sent", claimed_at: new Date().toISOString(), reconciled_status: null };
      return [{ order_id: args[0] }];
    }
    if (statement.startsWith("update refund_provider_claims") && statement.includes("reconciled_refunded")) { if (claim) claim.stage = "reconciled_refunded"; return []; }
    if (statement.startsWith("update refund_provider_claims")) return [];
    if (statement.startsWith("update artifact_download_tokens")) { revocations++; return []; }
    return [];
  } };
  const env = { REFUND_AUTO_DISPATCH: flag, MERCADOPAGO_ACCESS_TOKEN: token,
    MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-FAKE-SANDBOX", RESEND_API_KEY: "fake-resend", OWNER_ALERT_EMAIL: "owner@example.com",
    ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://fake.invalid/test" };
  const request = () => new Request("https://zevanory.api.br/api/support/refund-request", { method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
    body: JSON.stringify({ order_id: OID, email: EMAIL }) });
  const invoke = async () => { const r = await handleRefundFlow(request(), env, { sqlFactory: () => sql }); return { status: r.status, body: await r.json() }; };
  const installFetch = () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === "https://api.resend.com/emails") { calls.emails.push(JSON.parse(options.body)); return Response.json({ id: "fake-email" }); }
      if (options.method === "POST") {
        calls.post++;
        assert.equal(options.headers["x-idempotency-key"], "zevanory-refund-" + OID, "[RA01] chave idempotente por pedido");
        return Response.json({ id: "refund-1", status: "approved", amount: 197 });
      }
      calls.get++;
      return Response.json(payment);
    };
    return () => { globalThis.fetch = original; };
  };
  return { invoke, installFetch, state, calls, claim: () => claim, revocations: () => revocations, env };
}

test("RA01 elegível: confirma consumidor, reserva e faz uma chamada com chave idempotente", async () => {
  const x = fixture(), restore = x.installFetch();
  try {
    const out = await x.invoke();
    assert.equal(out.status, 200, "[RA01] resposta aceita");
    assert.equal(out.body.status, "approved", "[RA01] resultado aprovado");
    assert.equal(x.calls.post, 1, "[RA01] uma chamada financeira");
    assert.equal(x.claim().stage, "reconciled_refunded", "[RA01] reserva durável precede conclusão");
    assert.equal(x.revocations(), 1, "[RA01] downloads revogados");
    assert.match(x.calls.emails[0].text, /Protocolo:/, "[RA01] confirmação imediata com protocolo");
    assert.match(x.calls.emails.at(-1).subject, /despacho automático/, "[RA01] proprietário recebe notificação");
  } finally { restore(); }
});

test("RA02 reinício depois do registro e antes da reserva não cria chamada na repetição", async () => {
  const x = fixture({ failAfterRecord: true }), restore = x.installFetch();
  try {
    assert.equal((await x.invoke()).status, 503, "[RA02] primeira execução interrompida");
    assert.equal((await x.invoke()).status, 200, "[RA02] repetição reconhece protocolo existente");
    assert.equal(x.calls.post, 0, "[RA02] nenhuma segunda chamada");
  } finally { restore(); }
});

test("RA03 duplo pedido concorrente é serializado pela reserva: uma chamada", async () => {
  const x = fixture(), restore = x.installFetch();
  try {
    const out = await Promise.all([x.invoke(), x.invoke()]);
    assert.equal(x.calls.post, 1, "[RA03] uma chamada financeira sob concorrência");
    assert.equal(out.filter((r) => r.status === 200).length >= 1, true, "[RA03] ao menos uma confirmação");
  } finally { restore(); }
});

test("RA04 timeout e 5xx são outcome_unknown e nunca têm repetição cega", async () => {
  for (const mode of ["timeout", "500"]) {
    const x = fixture(), restore = x.installFetch();
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) === "https://api.resend.com/emails" || options.method !== "POST") return baseFetch(url, options);
      x.calls.post++;
      if (mode === "timeout") throw Error("timeout");
      return Response.json({ message: "upstream" }, { status: 500 });
    };
    try {
      const first = await x.invoke();
      assert.equal(first.status, 200, "[RA04] recebimento confirmado apesar do resultado ambíguo");
      assert.match(first.body.processing, /mercadopago_refund_/, "[RA04] diagnóstico de processamento preservado");
      assert.equal(JSON.parse(x.state.get(KEY)).provider_outcome_unknown, true, "[RA04] marcador outcome_unknown");
      assert.equal((await x.invoke()).status, 200, "[RA04] repetição apenas confirma recebimento");
      assert.equal(x.calls.post, 1, "[RA04] sem nova tentativa cega");
    } finally { restore(); }
  }
});

test("RA05 exceções vão para fila manual sem POST e guardam motivo claro", async () => {
  const scenarios = [
    ["identity_mismatch", {}, { payer: { email: "other@example.com" } }, "other@example.com"],
    ["outside_withdrawal_window", { paid_at: new Date(Date.now() - 20 * DAY).toISOString(), delivered_at: new Date(Date.now() - 10 * DAY).toISOString() }, {}, EMAIL],
    ["provider_dispute_or_chargeback", {}, { status_detail: "charged_back" }, EMAIL],
    ["payment_amount_mismatch", {}, { transaction_amount: 196 }, EMAIL],
    ["payment_already_refunded", {}, { transaction_amount_refunded: 197, refunds: [{ id: 1, status: "approved" }] }, EMAIL],
    ["certification_pilot", { certification_pilot: true }, {}, EMAIL],
  ];
  for (const [reason, orderExtra, paymentExtra, evidenceEmail] of scenarios) {
    const order = baseOrder(orderExtra), payment = basePayment(paymentExtra);
    const x = fixture({ order, payment, evidenceEmail }), restore = x.installFetch();
    try {
      const out = await x.invoke();
      assert.equal(out.status, 200, "[RA05] fila manual: " + reason);
      assert.equal(JSON.parse(x.state.get(KEY)).manual_reason, reason, "[RA05] motivo: " + reason);
      assert.equal(x.calls.post, 0, "[RA05] sem chamada: " + reason);
    } finally { restore(); }
  }
});

test("RA06 token sandbox em produção falha fechado, alerta e não consulta provedor", async () => {
  const x = fixture({ token: "TEST-WRONG-ENVIRONMENT" }), restore = x.installFetch();
  try {
    const out = await x.invoke();
    assert.equal(out.status, 200, "[RA06] pedido permanece recebido");
    assert.equal(JSON.parse(x.state.get(KEY)).manual_reason, "credential_environment_mismatch", "[RA06] motivo explícito");
    assert.equal(x.calls.get, 0, "[RA06] nenhuma chamada ao Mercado Pago");
    assert.equal(x.calls.post, 0, "[RA06] nenhuma operação financeira");
    assert.ok(x.calls.emails.some((x) => /credencial incompatível/.test(x.subject)), "[RA06] alerta ao proprietário");
  } finally { restore(); }
});

test("RA07 interruptor ausente ou false preserva o fluxo manual", async () => {
  for (const flag of [undefined, "false", "FALSE", "0"]) assert.equal(refundAutoDispatchEnabled({ REFUND_AUTO_DISPATCH: flag }), false, "[RA07] padrão desligado");
  const results = [];
  for (const flag of [null, "false"]) {
    const x = fixture({ flag }), restore = x.installFetch();
    try { const out = await x.invoke(); results.push({ status: out.status, bodyStatus: out.body.status, posts: x.calls.post, recordStatus: JSON.parse(x.state.get(KEY)).status }); }
    finally { restore(); }
  }
  assert.deepEqual(results[0], results[1], "[RA07] ausente equivale exatamente a false");
  assert.deepEqual(results[0], { status: 200, bodyStatus: "pending", posts: 0, recordStatus: "pending" }, "[RA07] comportamento atual: aguarda aprovação");
});

test("RA08 matriz pura de elegibilidade exige pedido, oferta, valor, estado e ausência de disputa", () => {
  const ok = { order: baseOrder(), payment: basePayment(), window: { eligible: true }, identityMatched: true, test: false, credential: { ok: true } };
  assert.equal(evaluateAutomaticRefund(ok).eligible, true, "[RA08] baseline elegível");
  const cases = [
    ["identity_mismatch", { identityMatched: false }], ["outside_withdrawal_window", { window: { eligible: false } }],
    ["certification_pilot", { test: true }], ["credential_environment_mismatch", { credential: { ok: false } }],
    ["order_not_paid", { order: baseOrder({ status: "created" }) }], ["payment_not_approved", { payment: basePayment({ status: "pending" }) }],
    ["provider_dispute_or_chargeback", { payment: basePayment({ dispute_id: "d1" }) }],
    ["payment_already_refunded", { payment: basePayment({ refunds: [{ id: 1 }] }) }],
    ["payment_amount_mismatch", { payment: basePayment({ transaction_amount: 190 }) }],
    ["payment_order_mismatch", { payment: basePayment({ external_reference: "other", metadata: { zevanory_order_id: "other", offer_id: "ZEV-IA-011" } }) }],
    ["payment_offer_mismatch", { payment: basePayment({ metadata: { zevanory_order_id: OID, offer_id: "OTHER" } }) }],
  ];
  for (const [reason, mutation] of cases) assert.deepEqual(evaluateAutomaticRefund({ ...ok, ...mutation }), { eligible: false, reason }, "[RA08] " + reason);
  assert.equal(validateMercadoPagoCredential({ MERCADOPAGO_ACCESS_TOKEN: "TEST-X" }, false).ok, false, "[RA08] produção recusa TEST-");
  assert.equal(validateMercadoPagoCredential({ MERCADOPAGO_TEST_ACCESS_TOKEN: "APP_USR-X" }, true).ok, false, "[RA08] sandbox recusa token produtivo");
});
