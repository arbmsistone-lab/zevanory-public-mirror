// B05 / Ordem 076-7 — unidade (sem banco) do webhook de validação de saque/estorno Pix Asaas.
import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAsaasPixRefund, createAsaasRefundIntent, handleAsaasPixRefundAuthorization, parsePixRefundRequest, refundValueCents } from "../../worker/asaas-pix-refund-auth.mjs";

const TOKEN = "k".repeat(40);
const ENV = { ASAAS_WITHDRAW_AUTH_TOKEN: TOKEN, SALE_GLOBALLY_ENABLED: "false", CERTIFICATION_PILOT_ENV: "sandbox" };
const BODY = { type: "PIX_REFUND", pixRefund: { id: "3f1c2b7e-0000-4000-8000-000000000001", value: 5, payment: "pay_abcdef123456" } };
const sqlReturning = (rows) => ({ calls: [], async query(text, params) { this.calls.push({ text, params }); return rows; } });

test("U1 forma válida SEM intenção persistida => REFUSED (o defeito antigo aprovava pela forma)", async () => {
  const sql = sqlReturning([]);
  const d = await authorizeAsaasPixRefund({ env: ENV, token: TOKEN, body: BODY, sql });
  assert.equal(d.status, "REFUSED");
  assert.equal(d.refuseReason, "no_matching_intent");
  assert.deepEqual(sql.calls[0].params, ["pay_abcdef123456", 500, BODY.pixRefund.id], "consulta exata: payment id, centavos, id do estorno");
});

test("U2 linha devolvida que não casa com o pedido => REFUSED (defesa em profundidade)", async () => {
  for (const row of [{ payment_id: "pay_outro0000001", amount_cents: "500", order_id: "o" }, { payment_id: "pay_abcdef123456", amount_cents: "501", order_id: "o" }]) {
    const d = await authorizeAsaasPixRefund({ env: ENV, token: TOKEN, body: BODY, sql: sqlReturning([row]) });
    assert.equal(d.status, "REFUSED", JSON.stringify(row));
    assert.equal(d.refuseReason, "intent_mismatch");
  }
  const ok = await authorizeAsaasPixRefund({ env: ENV, token: TOKEN, body: BODY, sql: sqlReturning([{ payment_id: "pay_abcdef123456", amount_cents: "500", order_id: "o" }]) });
  assert.equal(ok.status, "APPROVED");
});

test("U3 token: ausente/curto/errado/array => REFUSED sem consultar o banco", async () => {
  for (const [env, token] of [[{ ...ENV, ASAAS_WITHDRAW_AUTH_TOKEN: "" }, TOKEN], [{ ...ENV, ASAAS_WITHDRAW_AUTH_TOKEN: "short" }, "short"], [ENV, "x".repeat(40)], [ENV, [TOKEN]], [ENV, ""]]) {
    const sql = sqlReturning([{ payment_id: "pay_abcdef123456", amount_cents: "500" }]);
    const d = await authorizeAsaasPixRefund({ env, token, body: BODY, sql });
    assert.equal(d.status, "REFUSED");
    assert.equal(sql.calls.length, 0);
  }
});

test("U4 ambiente: vendas abertas ou fora do sandbox => REFUSED sem consultar o banco", async () => {
  for (const env of [{ ...ENV, SALE_GLOBALLY_ENABLED: "true" }, { ...ENV, CERTIFICATION_PILOT_ENV: "production" }]) {
    const sql = sqlReturning([{ payment_id: "pay_abcdef123456", amount_cents: "500" }]);
    assert.equal((await authorizeAsaasPixRefund({ env, token: TOKEN, body: BODY, sql })).refuseReason, "fail_closed_environment_required");
    assert.equal(sql.calls.length, 0);
  }
});

test("U5 tipos e formas fora do contrato => REFUSED", async () => {
  const bad = [
    { ...BODY, type: "TRANSFER" }, { type: "PIX_REFUND" }, { type: "PIX_REFUND", pixRefund: { ...BODY.pixRefund, payment: "xyz" } },
    { type: "PIX_REFUND", pixRefund: { ...BODY.pixRefund, value: 0.001 } }, { type: "PIX_REFUND", pixRefund: { ...BODY.pixRefund, value: "1e3" } },
    { type: "PIX_REFUND", pixRefund: { ...BODY.pixRefund, id: "x" } }, null,
  ];
  for (const body of bad) {
    const sql = sqlReturning([{ payment_id: "pay_abcdef123456", amount_cents: "500" }]);
    assert.equal((await authorizeAsaasPixRefund({ env: ENV, token: TOKEN, body, sql })).status, "REFUSED", JSON.stringify(body));
    assert.equal(sql.calls.length, 0);
  }
  assert.equal(refundValueCents(197), 19700);
  assert.equal(refundValueCents("19.9"), 1990);
  assert.ok(Number.isNaN(refundValueCents(19.999)));
  assert.equal(parsePixRefundRequest(BODY).amountCents, 500);
});

test("U6 banco indisponível ou com erro => REFUSED explícito (nunca 5xx que o Asaas reenviaria)", async () => {
  assert.equal((await authorizeAsaasPixRefund({ env: ENV, token: TOKEN, body: BODY, sql: null })).refuseReason, "intent_storage_unavailable");
  const d = await authorizeAsaasPixRefund({ env: ENV, token: TOKEN, body: BODY, sql: { async query() { throw new Error("boom"); } } });
  assert.equal(d.status, "REFUSED");
  assert.equal(d.http, 200);
});

test("U7 rota: outro caminho => null; GET => 405; POST sem intenção => REFUSED", async () => {
  assert.equal(await handleAsaasPixRefundAuthorization(new Request("https://zevanory.api.br/api/outra"), ENV), null);
  assert.equal((await handleAsaasPixRefundAuthorization(new Request("https://zevanory.api.br/api/asaas/withdraw-authorization"), ENV)).status, 405);
  const res = await handleAsaasPixRefundAuthorization(new Request("https://zevanory.api.br/api/asaas/withdraw-authorization", { method: "POST", headers: { "asaas-access-token": TOKEN }, body: JSON.stringify(BODY) }), ENV, { sql: sqlReturning([]), logger: { info() {} } });
  assert.equal((await res.json()).status, "REFUSED");
});

test("U8 criação valida entrada antes do banco", async () => {
  const sql = sqlReturning([]);
  const base = { orderId: "3f1c2b7e-0000-4000-8000-000000000001", paymentId: "pay_abcdef123456", amountCents: 500, approvedBy: "owner:admin" };
  assert.equal((await createAsaasRefundIntent(sql, { ...base, orderId: "x" })).reason, "order_id_invalid");
  assert.equal((await createAsaasRefundIntent(sql, { ...base, amountCents: 5.5 })).reason, "amount_invalid");
  assert.equal((await createAsaasRefundIntent(sql, { ...base, approvedBy: "" })).reason, "approver_invalid");
  assert.equal(sql.calls.length, 0);
  assert.equal((await createAsaasRefundIntent(sql, base)).reason, "order_not_eligible");
  assert.equal(sql.calls.at(-1).params[5], 15 * 60 * 1000, "TTL padrão 15 min");
});
