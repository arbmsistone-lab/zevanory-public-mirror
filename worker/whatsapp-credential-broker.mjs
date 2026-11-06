// giro-whatsapp-bridge (former WhatsApp credential broker) — RETIRED, tombstone only.
//
// Meta permanently disabled the ZEVANORY WhatsApp Business account (WABA 4019600665012911) on
// 2026-10-10. Every broker route used to call the Meta Graph API with stored credentials: the
// unauthenticated runtime route even ran a full Meta status check (permissions, app secret, phone
// identity) on each anonymous hit; the send, media, request-code, verify-code, oauth and
// verify-signature/token routes sent messages, registered the number or validated signatures.
// All of it is removed. Every request, internal or public, answers 410 Gone
// and nothing here reads a binding, a secret, D1 or KV, or performs any outbound fetch.
// The owner should delete this Worker (see docs/WHATSAPP_APOSENTADO.md); this file only guarantees
// that a redeploy can never bring the old behavior back.
const GONE = Object.freeze({
  ok: false,
  service: "giro-whatsapp-bridge",
  retired: true,
  error: "whatsapp_channel_retired",
  reason: "meta_account_permanently_disabled",
  canonical: "https://zevanory.api.br"
});

export default {
  async fetch() {
    return new Response(JSON.stringify(GONE), {
      status: 410,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
    });
  }
};
