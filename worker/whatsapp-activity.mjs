// P1-4 panel visibility for WhatsApp: masked reply and purchase-link events.
// Refs are hashed by emitActivity; no phone number, message text or provider id
// is stored. Called only after the provider accepted the text reply.
import { emitActivity } from "./activity-ledger.mjs";
const PURCHASE_LINK = /https:\/\/vendas\.zevanory\.api\.br\/comprar\/ZEV-[A-Z0-9-]+(?:\?[^\s)]*)?/;
export async function recordWhatsappReplyActivity(kv, item, reply, sentText, { now = Date.now() } = {}) {
  if (!kv?.get || !kv?.put || sentText?.ok !== true) return { emitted: 0 };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const id = String(item?.message_id || sentText?.provider_message_id || "");
  if (!id) return { emitted: 0 };
  let emitted = 0;
  const a = await emitActivity(env, { type: "whatsapp_replied", channel: "whatsapp", status: reply?.escalated ? "escalated" : "replied", ref: "wa:" + id }, { now });
  if (a?.emitted) emitted++;
  const link = (String(reply?.body || "").match(PURCHASE_LINK) || [])[0];
  if (link) {
    const b = await emitActivity(env, { type: "link_sent", channel: "whatsapp", status: "sent", ref: "wa-link:" + id, link }, { now });
    if (b?.emitted) emitted++;
  }
  return { emitted };
}
