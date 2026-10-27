import { verifyProductionToken } from "./commercial-checkout-guard.mjs";

const MONEY_EPSILON = 0.005;

export const refundAutoDispatchEnabled = (env = {}) =>
  env.REFUND_AUTO_DISPATCH === "true";

export const refundIdempotencyKey = (orderId) => "zevanory-refund-" + String(orderId || "").toLowerCase();

export async function validateMercadoPagoCredential(env, test, { verify = verifyProductionToken } = {}) {
  const token = String((test ? env.MERCADOPAGO_TEST_ACCESS_TOKEN : env.MERCADOPAGO_ACCESS_TOKEN) || "").trim();
  if (!token) return { ok: false, reason: "mercadopago_token_missing", token: "" };
  const mode = String(env.MERCADOPAGO_ENV || "").trim().toLowerCase();
  const sandboxToken = /^test-/i.test(token);
  if (test) {
    if (mode !== "sandbox" || !sandboxToken) return { ok: false, reason: "sandbox_token_expected", token: "" };
  } else {
    if (mode !== "production" || sandboxToken || !await verify(env))
      return { ok: false, reason: "production_account_unverified", token: "" };
  }
  return { ok: true, reason: null, token };
}

const moneyMatches = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) &&
  Math.abs(Number(a) - Number(b)) < MONEY_EPSILON;

function providerHasDispute(payment) {
  const signals = [payment?.status, payment?.status_detail, payment?.operation_type,
    payment?.dispute_status, payment?.chargeback_status,
    ...(Array.isArray(payment?.charges_details) ? payment.charges_details.flatMap((x) => [x?.name, x?.type, x?.status]) : [])]
    .map((x) => String(x || "").toLowerCase());
  return Boolean(payment?.dispute_id || payment?.chargeback_id || Number(payment?.amount_refunded_by_chargeback || 0) > 0 ||
    signals.some((x) => x.includes("chargeback") || x.includes("charged_back") || x.includes("dispute")));
}

function paymentOfferId(payment) {
  const metadata = payment?.metadata && typeof payment.metadata === "object" ? payment.metadata : {};
  if (metadata.offer_id) return String(metadata.offer_id);
  const items = Array.isArray(payment?.additional_info?.items) ? payment.additional_info.items : [];
  return items.length === 1 && items[0]?.id ? String(items[0].id) : "";
}

export function evaluateAutomaticRefund({ order, payment, window, identityMatched, test, credential }) {
  if (!identityMatched) return { eligible: false, reason: "identity_mismatch" };
  if (!window?.eligible) return { eligible: false, reason: "outside_withdrawal_window" };
  if (test || order?.certification_pilot === true) return { eligible: false, reason: "certification_pilot" };
  if (!credential?.ok) return { eligible: false, reason: "credential_environment_mismatch" };
  if (String(order?.status || "") !== "paid") return { eligible: false, reason: "order_not_paid" };
  if (String(payment?.status || "") !== "approved") return { eligible: false, reason: "payment_not_approved" };
  if (providerHasDispute(payment)) return { eligible: false, reason: "provider_dispute_or_chargeback" };
  // A missing refund snapshot is UNKNOWN, never proof that nothing was refunded.
  if (payment?.transaction_amount_refunded == null || !Array.isArray(payment?.refunds) ||
      !Number.isFinite(Number(payment.transaction_amount_refunded)) || Number(payment.transaction_amount_refunded) < 0)
    return { eligible: false, reason: "refund_snapshot_unverified" };
  if (payment.status_detail !== "accredited") return { eligible: false, reason: "payment_detail_unapproved" };
  const refunded = Number(payment.transaction_amount_refunded);
  if (refunded > 0 || payment.refunds.length > 0)
    return { eligible: false, reason: "payment_already_refunded" };
  if (!moneyMatches(order?.amount, payment?.transaction_amount)) return { eligible: false, reason: "payment_amount_mismatch" };
  const expectedOrder = String(order?.order_id || "").toLowerCase();
  const metadataOrder = String(payment?.metadata?.zevanory_order_id || "").toLowerCase();
  const external = String(payment?.external_reference || "").toLowerCase();
  if (metadataOrder !== expectedOrder && external !== expectedOrder && !external.endsWith(":" + expectedOrder))
    return { eligible: false, reason: "payment_order_mismatch" };
  if (paymentOfferId(payment) !== String(order?.offer_id || ""))
    return { eligible: false, reason: "payment_offer_mismatch" };
  return { eligible: true, reason: null };
}
