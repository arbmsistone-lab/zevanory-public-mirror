import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutomaticRefund, refundAutoDispatchEnabled, refundIdempotencyKey, validateMercadoPagoCredential } from "../worker/refund-auto-dispatch.mjs";
import { isAmbiguousRefund } from "../worker/refund-provider-claims.mjs";

const OID = "11111111-2222-4333-8444-555555555555";
const order = (x = {}) => ({ order_id: OID, status: "paid", amount: 197, offer_id: "OFFER", certification_pilot: false, ...x });
const payment = (x = {}) => ({ status: "approved", status_detail: "accredited", transaction_amount: 197,
  transaction_amount_refunded: 0, refunds: [], external_reference: OID,
  metadata: { zevanory_order_id: OID, offer_id: "OFFER" }, ...x });
const args = (x = {}) => ({ order: order(), payment: payment(), window: { eligible: true }, identityMatched: true,
  test: false, credential: { ok: true }, ...x });
const denied = (label, expected, x) => test(label, () => assert.equal(evaluateAutomaticRefund(args(x)).reason, expected, label));

test("A01 flag somente true", () => assert.equal(refundAutoDispatchEnabled({ REFUND_AUTO_DISPATCH: "false" }), false, "A01"));
test("A02 produção recusa TEST", () => assert.equal(validateMercadoPagoCredential({ MERCADOPAGO_ACCESS_TOKEN: "TEST-X" }, false).ok, false, "A02"));
test("A03 sandbox recusa produção", () => assert.equal(validateMercadoPagoCredential({ MERCADOPAGO_TEST_ACCESS_TOKEN: "APP_USR-X" }, true).ok, false, "A03"));
test("A04 token ausente", () => assert.equal(validateMercadoPagoCredential({}, false).ok, false, "A04"));
test("A05 tolerância monetária", () => assert.equal(evaluateAutomaticRefund(args({ payment: payment({ transaction_amount: 197.01 }) })).reason, "payment_amount_mismatch", "A05"));
test("A06 sinal de disputa", () => assert.equal(evaluateAutomaticRefund(args({ payment: payment({ status_detail: "in_dispute" }) })).reason, "provider_dispute_or_chargeback", "A06"));
denied("A07 identidade", "identity_mismatch", { identityMatched: false });
denied("A08 janela", "outside_withdrawal_window", { window: { eligible: false } });
denied("A09 modo teste", "certification_pilot", { test: true });
denied("A10 piloto", "certification_pilot", { order: order({ certification_pilot: true }) });
denied("A11 credencial", "credential_environment_mismatch", { credential: { ok: false } });
denied("A12 pedido pago", "order_not_paid", { order: order({ status: "created" }) });
denied("A13 pagamento aprovado", "payment_not_approved", { payment: payment({ status: "pending" }) });
denied("A14 chargeback", "provider_dispute_or_chargeback", { payment: payment({ chargeback_id: "c1" }) });
denied("A15 total já devolvido", "payment_already_refunded", { payment: payment({ transaction_amount_refunded: 1 }) });
denied("A16 lista de refunds", "payment_already_refunded", { payment: payment({ refunds: [{ id: 1 }] }) });
denied("A17 valor", "payment_amount_mismatch", { payment: payment({ transaction_amount: 190 }) });
denied("A18 pedido", "payment_order_mismatch", { payment: payment({ external_reference: "other", metadata: { zevanory_order_id: "other", offer_id: "OFFER" } }) });
denied("A19 oferta", "payment_offer_mismatch", { payment: payment({ metadata: { zevanory_order_id: OID, offer_id: "OTHER" } }) });
test("A20 chave idempotente", () => assert.equal(refundIdempotencyKey(OID), "zevanory-refund-" + OID, "A20"));
test("A21 estado ambíguo", () => assert.equal(isAmbiguousRefund({ last_error: "mercadopago_refund_outcome_unknown" }), true, "A21"));
