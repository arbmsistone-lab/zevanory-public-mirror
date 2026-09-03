export const PUBLIC_EVENTS = new Set([
  "page_view",
  "cta_whatsapp",
]);

export const OPERATOR_EVENTS = new Set([
  "lead_qualified",
  "offer_sent",
  "checkout_started",
]);

export const OPERATOR_EVIDENCE_EVENTS = new Set([
  "identity_verified","enrichment_verified","scoring_completed","prioritization_completed",
  "first_response_confirmed","discovery_completed","nurturing_touch_confirmed",
  "objection_handled","negotiation_completed","abandonment_recovered","fulfillment_confirmed",
]);

export const FINANCIAL_EVENTS = new Set([
  "payment_confirmed",
  "refund_confirmed",
]);

export function validateEventName(name) {
  return PUBLIC_EVENTS.has(name) || OPERATOR_EVENTS.has(name) || OPERATOR_EVIDENCE_EVENTS.has(name) || FINANCIAL_EVENTS.has(name);
}

export function sanitizeText(value, max = 160) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
