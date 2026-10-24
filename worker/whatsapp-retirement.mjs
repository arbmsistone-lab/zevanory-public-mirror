// ZEVANORY | WhatsApp channel retirement (global kill-switch, fail-closed).
//
// Fact: Meta PERMANENTLY disabled the ZEVANORY WhatsApp Business account (WABA 4019600665012911,
// phone_number_id 1300972319774588) on 2026-10-10 for Acceptable Use violations. Probable cause:
// CI "delivery proof" workflows forged signed inbound webhooks so the live bot sent real automated
// free-form replies (prices/links) to the owner's personal number, including outside the 24h window.
//
// Contract:
//   * WHATSAPP_CHANNEL_RETIRED defaults to TRUE in code: absence, empty or any value other than the
//     literal "false" means retired. Only an explicit "false" re-enables the code paths.
//   * When retired: no Graph API call, no broker call, no credential load, no automated reply, no
//     storage of inbound message content. Status reports the channel as permanently disabled and the
//     channel never counts toward health checks or channel quorum.
//   * WHATSAPP_INSTANT_REPLY defaults to FALSE and is forced off while retired.
export const WHATSAPP_RETIRED_REASON = "meta_account_permanently_disabled";
export const WHATSAPP_RETIRED_MODE = "disabled_permanent";
export const WHATSAPP_RETIRED_STATE = "retired";
export const WHATSAPP_RETIRED_SINCE = "2026-10-10";

export function whatsappChannelRetired(env) {
  const raw = env && typeof env === "object" ? env.WHATSAPP_CHANNEL_RETIRED : undefined;
  if (raw === undefined || raw === null) return true;
  return String(raw).trim().toLowerCase() !== "false";
}

export function whatsappInstantReplyEnabled(env) {
  if (whatsappChannelRetired(env)) return false;
  return String(env?.WHATSAPP_INSTANT_REPLY ?? "").trim().toLowerCase() === "true";
}

export function retiredWhatsappStatus() {
  return Object.freeze({
    state: WHATSAPP_RETIRED_STATE,
    mode: WHATSAPP_RETIRED_MODE,
    reason: WHATSAPP_RETIRED_REASON,
    since: WHATSAPP_RETIRED_SINCE,
    counts_toward_quorum: false,
    counts_toward_health: false
  });
}

// Readiness entry used wherever a channel map is projected (status, closure, continuity).
export function retiredWhatsappChannelEntry(base = {}) {
  return Object.freeze({
    ...(base && typeof base === "object" ? base : {}),
    configured: false,
    api_configured: false,
    alternate_api_configured: false,
    contingency_ready: false,
    active_provider: null,
    operational_ready: false,
    operational_mode: WHATSAPP_RETIRED_MODE,
    commercial_execution: WHATSAPP_RETIRED_MODE,
    release_gate: WHATSAPP_RETIRED_MODE,
    scope_status: WHATSAPP_RETIRED_STATE,
    standby_reason: WHATSAPP_RETIRED_REASON,
    retired: true,
    retired_reason: WHATSAPP_RETIRED_REASON,
    counts_toward_active_total: false
  });
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

// 410 Gone for every retired WhatsApp route (onboarding, proof, broker, admin).
export function whatsappGoneResponse(route = "whatsapp") {
  return new Response(JSON.stringify({ ok: false, error: "whatsapp_channel_retired", reason: WHATSAPP_RETIRED_REASON, route: String(route).slice(0, 80) }), { status: 410, headers: JSON_HEADERS });
}

// Meta webhook acknowledgement while retired. Meta's Webhooks guidance: answer every delivery with
// 200 OK quickly; non-2xx answers are retried (with backoff, for days) and repeated failures flag or
// disable the app subscription. 410 has no special meaning for Meta, it is just another failure, so
// the retired route acknowledges with 200 and does nothing else: no signature check against stored
// secrets, no parsing beyond the object type, no storage of message content, no reply.
export function whatsappWebhookAckResponse() {
  return new Response(JSON.stringify({ accepted: true, processed: false, stored: false, reason: WHATSAPP_RETIRED_REASON }), { status: 200, headers: JSON_HEADERS });
}

// True when a raw Meta webhook body belongs to the WhatsApp Business product (object type only).
export function isWhatsappWebhookBody(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return false;
  try {
    return JSON.parse(text)?.object === "whatsapp_business_account";
  } catch {
    return false;
  }
}

// Hosts the retired channel must never reach.
export function isWhatsappProviderUrl(input) {
  let url;
  try { url = new URL(typeof input === "string" ? input : input?.url || String(input)); } catch { return false; }
  return url.hostname === "graph.facebook.com" || url.hostname.endsWith(".graph.facebook.com") ||
    url.hostname === "whatsapp-broker.internal" || url.hostname.startsWith("giro-whatsapp-bridge.");
}
