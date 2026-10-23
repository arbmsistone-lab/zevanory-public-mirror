// B05 / Ordem 076-7 — autorização de estorno Pix Asaas por INTENÇÃO PERSISTIDA, contra PostgreSQL efêmero real.
// Prova: só aprova com intenção gravada, não vencida, não usada e EXATA (payment id + valor); uso único mesmo
// com conexões concorrentes reais; o resto é REFUSED.
// Run: T4_PG_HOST=... T4_PG_PORT=... node --test tests/integration/psp-refund-intent-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SKIP, psqlRaw, psqlAsync, asyncSql, rowsSync, inline } from "./psp-pg.mjs";
import { CONSUME_REFUND_INTENT_SQL, authorizeAsaasPixRefund, createAsaasRefundIntent, handleAsaasPixRefundAuthorization } from "../../worker/asaas-pix-refund-auth.mjs";

const TOKEN = "t".repeat(48);
const ENV = { ASAAS_WITHDRAW_AUTH_TOKEN: TOKEN, SALE_GLOBALLY_ENABLED: "false", CERTIFICATION_PILOT_ENV: "sandbox" };
let seq = 0;

function paidAsaasOrder({ amount = "197.00", provider = "asaas", status = "paid", confirmed = true } = {}) {
  const id = randomUUID();
  const payment = `pay_t4${String(++seq).padStart(8, "0")}`;
  psqlRaw(inline(`insert into orders (order_id, offer_id, amount, provider, external_reference, status) values ($1,'ZEV-IA-011',$2,$3,$4,$5);`, [id, amount, provider, `ZEVANORY:EXP-0001:${id}`, status]));
  if (confirmed) psqlRaw(inline(`insert into financial_events (provider_event_id, provider, provider_payment_id, normalized_event, order_id, amount) values ($1,$2,$3,'payment_confirmed',$4,$5);`, [`evt_${payment}`, provider, payment, id, amount]));
  return { id, payment, cents: Math.round(Number(amount) * 100) };
}
const request = (payment, value, refundId = randomUUID()) => ({ type: "PIX_REFUND", pixRefund: { id: refundId, value, payment, status: "AWAITING_REQUEST", type: "CREDIT_REFUND" } });
const decide = (body, { env = ENV, token = TOKEN, sql = asyncSql } = {}) => authorizeAsaasPixRefund({ env, token, body, sql });
const intentRow = (payment) => rowsSync("select nonce, used_at, used_refund_id, revoked_at from asaas_refund_intents where payment_id=$1 order by created_at", [payment]);

before(() => {
  if (SKIP) return;
  psqlRaw("drop table if exists asaas_refund_intents cascade;\n");
  psqlRaw(readFileSync(new URL("../t4_sim/schema.sql", import.meta.url), "utf8"));
  psqlRaw(readFileSync(new URL("../../db/b05/asaas_refund_intents.sql", import.meta.url), "utf8"));
});

test("R1 válido: intenção exata aprova UMA vez e registra o id do estorno", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  const created = await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" });
  assert.equal(created.created, true, JSON.stringify(created));
  const d = await decide(request(o.payment, 197));
  assert.equal(d.status, "APPROVED");
  assert.equal(d.order_id, o.id);
  const [row] = intentRow(o.payment);
  assert.ok(row.used_at, "nonce consumido");
  assert.ok(row.used_refund_id, "id do estorno gravado");
});

test("R2 valor divergente => REFUSED e a intenção continua intacta", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: 5000, approvedBy: "owner:admin-refunds" })).created, true);
  for (const v of [50.01, 49.99, 197, "50.001", 0, -50]) {
    const d = await decide(request(o.payment, v));
    assert.equal(d.status, "REFUSED", `valor ${v}`);
  }
  assert.equal(intentRow(o.payment)[0].used_at, null);
  assert.equal((await decide(request(o.payment, 50))).status, "APPROVED", "o valor exato ainda aprova");
});

test("R3 pagamento desconhecido (sem intenção) => REFUSED", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" })).created, true);
  const d = await decide(request("pay_desconhecido01", 197));
  assert.equal(d.status, "REFUSED");
  assert.equal(d.refuseReason, "no_matching_intent");
  assert.equal(intentRow(o.payment)[0].used_at, null, "outra intenção não pode ser consumida");
});

test("R4 replay: o mesmo pedido (ou outro id de estorno no mesmo pagamento) depois do consumo => REFUSED", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" })).created, true);
  const body = request(o.payment, 197);
  assert.equal((await decide(body)).status, "APPROVED");
  const again = await decide(body);
  assert.equal(again.status, "REFUSED");
  assert.equal(again.refuseReason, "no_matching_intent");
  assert.equal((await decide(request(o.payment, 197))).status, "REFUSED");
});

test("R5 intenção vencida => REFUSED; nova intenção revoga a vencida e volta a valer", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" })).created, true);
  psqlRaw(inline("update asaas_refund_intents set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second' where payment_id=$1;", [o.payment]));
  const d = await decide(request(o.payment, 197));
  assert.equal(d.status, "REFUSED");
  assert.equal(intentRow(o.payment)[0].used_at, null);
  const again = await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" });
  assert.equal(again.created, true, JSON.stringify(again));
  const rows = intentRow(o.payment);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].revoked_at, "a vencida foi revogada");
  assert.equal((await decide(request(o.payment, 197))).status, "APPROVED");
});

test("R6 consumo concorrente: duas transações reais simultâneas, só UMA obtém o nonce", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" })).created, true);
  // A segura a linha (consumo dentro de transação aberta por 1,5 s); B chega no meio.
  const consume = (refundId, hold) => psqlAsync(`BEGIN;\n${inline(CONSUME_REFUND_INTENT_SQL, [o.payment, o.cents, refundId])};\nSELECT pg_sleep(${hold});\nCOMMIT;\n`);
  const a = consume("refund-a-0000001", 1.5);
  await new Promise((r) => setTimeout(r, 400));
  const b = consume("refund-b-0000001", 0);
  const [outA, outB] = await Promise.all([a, b]);
  const won = [outA, outB].filter((out) => out.includes(o.payment)).length;
  assert.equal(won, 1, `exatamente uma transação consome: A=${JSON.stringify(outA)} B=${JSON.stringify(outB)}`);
  assert.equal(rowsSync("select count(*)::int as n from asaas_refund_intents where payment_id=$1 and used_at is not null", [o.payment])[0].n, "1");
});

test("R7 rajada de 8 webhooks paralelos idênticos (conexões independentes) => exatamente 1 APPROVED", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" })).created, true);
  const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => decide(request(o.payment, 197, `refund-burst-${i}-000`))));
  assert.equal(outs.filter((d) => d.status === "APPROVED").length, 1, JSON.stringify(outs));
  assert.equal(outs.filter((d) => d.status === "REFUSED").length, 7);
});

test("R8 criação só para pedido Asaas pago com pagamento confirmado e valor <= pedido; uma intenção aberta por pagamento", { skip: SKIP }, async () => {
  const mk = async (o, extra = {}) => createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds", ...extra });
  assert.equal((await mk(paidAsaasOrder({ status: "checkout_ready" }))).reason, "order_not_eligible");
  assert.equal((await mk(paidAsaasOrder({ provider: "mercadopago" }))).reason, "order_not_eligible");
  assert.equal((await mk(paidAsaasOrder({ confirmed: false }))).reason, "order_not_eligible");
  const o = paidAsaasOrder();
  assert.equal((await mk(o, { amountCents: o.cents + 1 })).reason, "order_not_eligible");
  assert.equal((await mk(o, { paymentId: "pay_outropagamento1" })).reason, "order_not_eligible");
  assert.equal((await mk(o)).created, true);
  assert.equal((await mk(o)).reason, "open_intent_exists");
});

test("R9 token, ambiente e armazenamento: tudo fora do contrato => REFUSED (nunca APPROVED)", { skip: SKIP }, async () => {
  const o = paidAsaasOrder();
  assert.equal((await createAsaasRefundIntent(asyncSql, { orderId: o.id, paymentId: o.payment, amountCents: o.cents, approvedBy: "owner:admin-refunds" })).created, true);
  const body = request(o.payment, 197);
  assert.equal((await decide(body, { token: "x".repeat(48) })).http, 401);
  assert.equal((await decide(body, { token: "" })).status, "REFUSED");
  assert.equal((await decide(body, { env: { ...ENV, SALE_GLOBALLY_ENABLED: "true" } })).refuseReason, "fail_closed_environment_required");
  assert.equal((await decide(body, { sql: { async query() { throw new Error("relation does not exist"); } } })).refuseReason, "intent_storage_error");
  assert.equal(intentRow(o.payment)[0].used_at, null, "nenhuma recusa consome a intenção");
  // Rota HTTP real do módulo (o que o compat chama), com o mesmo banco.
  const res = await handleAsaasPixRefundAuthorization(new Request("https://zevanory.api.br/api/asaas/withdraw-authorization", { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": TOKEN }, body: JSON.stringify(body) }), ENV, { sql: asyncSql, logger: { info() {} } });
  assert.deepEqual(await res.json(), { status: "APPROVED" });
});
