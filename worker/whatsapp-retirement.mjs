// ZEVANORY | WhatsApp channel retirement (code constant, fail-closed).
//
// Fact: Meta PERMANENTLY disabled the ZEVANORY WhatsApp Business account (WABA 4019600665012911,
// phone_number_id 1300972319774588) on 2026-10-10 for Acceptable Use violations. Probable cause:
// CI "delivery proof" workflows forged signed inbound webhooks so the live bot sent real automated
// free-form replies (prices/links) to the owner's personal number, including outside the 24h window.
//
// Contract:
//   * Retirement is a CODE CONSTANT. No environment variable, runtime config, KV value or request can
//     reactivate the channel: WHATSAPP_CHANNEL_RETIRED=false and WHATSAPP_INSTANT_REPLY=true are
//     ignored. Any future return of WhatsApp requires a new reviewed PR that changes this file.
//   * Retired means: no Graph API call, no broker call, no credential load, no automated reply, no
//     storage of inbound message content. Status reports the channel as permanently disabled and the
//     channel never counts toward health checks or channel quorum.
export const WHATSAPP_RETIRED_REASON = "meta_account_permanently_disabled";
export const WHATSAPP_RETIRED_MODE = "disabled_permanent";
export const WHATSAPP_RETIRED_STATE = "retired";
export const WHATSAPP_RETIRED_SINCE = "2026-10-10";

export const WHATSAPP_CHANNEL_RETIRED = true;

// The argument is accepted (and deliberately ignored) so call sites stay explicit about which env they
// were handed; nothing in it can change the answer.
export function whatsappChannelRetired(_env) {
  return WHATSAPP_CHANNEL_RETIRED;
}

export function whatsappInstantReplyEnabled(_env) {
  return false;
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

// Meta webhook acknowledgement for PROVEN WhatsApp deliveries only. Meta's Webhooks guidance: answer
// every delivery with 200 OK quickly; non-2xx answers are retried (with backoff, for days) and repeated
// failures flag or disable the app subscription. 410 has no special meaning for Meta, it is just another
// failure, so a classified WhatsApp delivery is acknowledged with 200 and nothing else: no signature
// check against stored secrets, no processing, no storage of message content, no reply. Instagram,
// Facebook Page, oversized or unclassifiable deliveries are NOT acknowledged here: they go to the normal
// Meta handler (signature check, size limit, product routing).
export function whatsappWebhookAckResponse() {
  return new Response(JSON.stringify({ accepted: true, processed: false, stored: false, reason: WHATSAPP_RETIRED_REASON }), { status: 200, headers: { ...JSON_HEADERS, "x-zevanory-meta-product": "whatsapp_business_account", "x-zevanory-ack-layer": "edge" } });
}

export const META_WEBHOOK_CLASSIFY_MAX_BYTES = 256 * 1024;

// Classify the Meta product of a raw webhook body. Only a parseable body whose top-level object is
// "whatsapp_business_account" and whose every change is a WhatsApp field (messages, statuses or other
// WABA fields, never a Page/Instagram field) is "whatsapp". Page/Instagram objects are "page"/"instagram";
// anything else (empty, oversized, invalid JSON, mixed or unknown) is "unclassified".
const SOCIAL_FIELDS = new Set(["feed", "comments", "mentions", "messages_seen", "message_reactions", "story_insights", "live_comments", "messaging_postbacks"]);
export function classifyMetaWebhookBody(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text || text.length > META_WEBHOOK_CLASSIFY_MAX_BYTES) return "unclassified";
  let body;
  try { body = JSON.parse(text); } catch { return "unclassified"; }
  const object = body && typeof body === "object" ? body.object : undefined;
  if (object === "instagram") return "instagram";
  if (object === "page") return "page";
  if (object !== "whatsapp_business_account") return "unclassified";
  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    if (entry && typeof entry === "object" && Array.isArray(entry.messaging)) return "unclassified";
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const field = String(change?.field || "");
      if (!field || SOCIAL_FIELDS.has(field)) return "unclassified";
      const product = change?.value?.messaging_product;
      if (product !== undefined && product !== "whatsapp") return "unclassified";
    }
  }
  return "whatsapp";
}

export function isWhatsappWebhookBody(raw) {
  return classifyMetaWebhookBody(raw) === "whatsapp";
}

// Hosts the retired channel must never reach.
export function isWhatsappProviderUrl(input) {
  let url;
  try { url = new URL(typeof input === "string" ? input : input?.url || String(input)); } catch { return false; }
  return url.hostname === "graph.facebook.com" || url.hostname.endsWith(".graph.facebook.com") ||
    url.hostname === "whatsapp-broker.internal" || url.hostname.startsWith("giro-whatsapp-bridge.");
}
