// Order 13: privacy-safe, best-effort idempotent activity outbox.
// Shared KV namespace with ZEVANORY control panel. Nothing here changes payments,
// checkout, orders or sales switch. Refs are never stored un-hashed.
export const ACTIVITY_EVENT_PREFIX = "zpc-activity:v1:event:";
export const ACTIVITY_REF_PREFIX = "zpc-activity:v1:ref:";
export const ACTIVITY_TTL_SECONDS = 90 * 24 * 60 * 60;
export const ACTIVITY_TYPES = Object.freeze(new Set([
  "checkout_created", "payment_confirmed", "delivery_sent", "download_done",
  "refund_requested", "refund_approved", "refund_ambiguous",
  "post_published", "whatsapp_replied", "link_sent", "lead_captured",
  "email_sent", "owner_alert_sent", "sales_switch", "deploy",
  "certification", "review_received", "brand_blocked", "profile_updated"
]));
const CHANNELS = new Set([
  "checkout", "finance", "delivery", "download", "blog", "telegram",
  "instagram", "facebook", "whatsapp", "email", "owner", "system",
  "web", "affiliate", "store", "bluesky", "pinterest", "youtube"
]);
const LINK_HOSTS = new Set([
  "zevanory.api.br", "vendas.zevanory.api.br", "controle.zevanory.api.br",
  "t.me", "www.instagram.com", "instagram.com", "www.facebook.com", "facebook.com",
  "www.youtube.com", "youtube.com", "www.pinterest.com", "pinterest.com",
  "www.tiktok.com", "tiktok.com", "bsky.app"
]);
const sha256 = async value => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("");
};
function safeLink(input) {
  if (input == null || input === "") return null;
  try {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || url.username || url.password || !LINK_HOSTS.has(url.hostname)) return null;
    const params = new URLSearchParams();
    for (const key of ["utm_source","utm_medium","utm_campaign"]) {
      const value = url.searchParams.get(key);
      if (value && /^[a-z0-9_-]{1,60}$/i.test(value)) params.set(key,value);
    }
    return url.origin + url.pathname + (params.size ? "?" + params.toString() : "");
  } catch { return null; }
}
export async function emitActivity(env, {type, channel, status, ref, link, amount, financialProof} = {}, {now=Date.now()} = {}) {
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return {emitted:false,reason:"kv_unavailable"};
  if (!ACTIVITY_TYPES.has(type) || !CHANNELS.has(channel) ||
      !/^[a-z0-9_-]{1,64}$/.test(String(status||"")) ||
      typeof ref !== "string" || ref.length < 1 || ref.length > 256 ||
      !Number.isSafeInteger(now) || now <= 0 ||
      (amount != null && (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000)))
    return {emitted:false,reason:"invalid_input"};
  const financial = type==="payment_confirmed" || type==="refund_approved";
  // Finance is credited only by the provider-GET-verified read-side
  // reconciler. A raw webhook / client claim is not financial proof.
  if (financial && financialProof !== "provider-get-verified")
    return {emitted:false,reason:"financial_proof_required"};
  const normalizedLink=safeLink(link);
  if (link && !normalizedLink) return {emitted:false,reason:"invalid_link"};
  const digest=await sha256(type+":"+ref);
  const id=digest.slice(0,32);
  const marker=ACTIVITY_REF_PREFIX+digest;
  try {
    if (await kv.get(marker)) return {emitted:false,duplicate:true};
    // Event has no PII, payment ID, email, raw order ID or arbitrary text.
    const sourceKey="zpc-activity:"+type+":"+digest;
    const value={
      schema:"zevanory.activity.v1",type,kind:"event",
      title:type.replaceAll("_"," "),
      detail:"",
      channel,status,
      refHash:digest,sourceKey,
      link:normalizedLink,
      amountCents:amount??(financial?0:null),
      financialProof:financial?"provider-get-verified":null,
      evidence:[type,"source:zevanory-worker",new Date(now).toISOString()],
      at:new Date(now).toISOString()
    };
    const key=ACTIVITY_EVENT_PREFIX+now+":"+id;
    await kv.put(key,JSON.stringify(value),{expirationTtl:ACTIVITY_TTL_SECONDS});
    // Deliberately written after durable outbox entry: a crash cannot silently
    // consume the event. Control-panel consumer deduplicates sourceKey too.
    await kv.put(marker,key,{expirationTtl:ACTIVITY_TTL_SECONDS});
    return {emitted:true,refHash:digest,key};
  } catch {
    return {emitted:false,reason:"kv_write_failed"};
  }
}
