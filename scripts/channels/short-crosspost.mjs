// Cross-posts the day's rendered Short (same file the YouTube job uploaded) to
// TikTok, Instagram Reels and the Facebook Page. Each channel is independent,
// idempotent per local day (KV outcome key), and only counted as published on a
// provider-confirmed id. A channel without credentials/connection is reported as
// waiting, never as failure; a provider error fails the step visibly.
// Usage: node short-crosspost.mjs [--day=YYYY-MM-DD]
import { readFile } from "node:fs/promises";
import { planShort, planSlot, localDay, cloudflareKv, publicationWindow, channelSalesOpen, avGateSealed, CANDIDATE_PREFIX } from "./youtube-daily-short.mjs";
import { CLOSED_LABEL, SHORT_RULE, hasCheckoutCta } from "../../worker/politica-unica.mjs";
import { createHash } from "node:crypto";
import { emitActivity } from "../../worker/activity-ledger.mjs";
import { getPublisherAccessToken } from "./publisher-access.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
// P13c: the offer line follows the single policy (data/politica-unica.json) and the commercial lock:
// closed (default, fail-closed) => no price, no rule pitch, no checkout link, only "vendas fechadas".
export function captionFor(plan, channel, { salesOpen = false } = {}) {
  // Publish phase: the caption approved in the bundle is used verbatim (never recomputed from current code).
  const caption = plan.persistedCaptions?.[channel] ?? captionText(plan, channel, salesOpen === true);
  if (salesOpen !== true && hasCheckoutCta(caption)) throw new Error("caption_checkout_cta_while_closed");
  return caption;
}
function captionText(plan, channel, open) {
  const tags = "#pequenosnegocios #empreendedorismo #ia #zevanory";
  // oferta OPEN (owner switch): product + single 7-day rule. oferta CLOSED (default): free material only + "vendas fechadas".
  const offer = plan.slot && plan.slot !== "oferta" ? plan.screen.product + " · " + plan.screen.offer + "."
    : (open ? plan.entry.product.name : plan.screen.product + " · " + plan.screen.offer) + " · " + (open ? SHORT_RULE : CLOSED_LABEL) + ".";
  const base = plan.title.replace(/ #shorts$/i, "") + "\n\n" + plan.screen.tip + "\n\n" + offer;
  if (channel === "tiktok") return (base + "\n" + (plan.slot && plan.slot !== "oferta" ? "No site: vendas.zevanory.api.br" : "Guia completo: vendas.zevanory.api.br") + "\n\n" + tags).slice(0, 2200);
  return (base + "\nGuia completo: " + plan.link.replace("utm_source=youtube", "utm_source=" + channel) + "\n\n" + tags).slice(0, 2200);
}
async function jsonOrThrow(r, code) { const j = await r.json().catch(() => ({})); if (!r.ok || j?.error?.code && j.error.code !== "ok") throw new Error(code + "_http_" + r.status + (j?.error?.code && j.error.code !== "ok" ? "_" + String(j.error.code).replace(/[^a-z0-9_]/gi, "").slice(0, 40) : "")); return j; }

// TikTok Content Posting API (Direct Post, FILE_UPLOAD). Unaudited apps may only
// post SELF_ONLY; the privacy actually used is whatever creator_info allows.
export async function publishTikTok(plan, mp4, { token, audited = false, fetchImpl = fetch, sleep = sleepMs }) {
  const auth = { authorization: "Bearer " + token, "content-type": "application/json; charset=UTF-8" };
  const info = await jsonOrThrow(await fetchImpl("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { method: "POST", headers: auth, body: "{}" }), "tiktok_creator_info");
  const options = info?.data?.privacy_level_options || [];
  const privacy = audited && options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : options.includes("SELF_ONLY") ? "SELF_ONLY" : options[0];
  if (!privacy) throw new Error("tiktok_no_privacy_option");
  const init = await jsonOrThrow(await fetchImpl("https://open.tiktokapis.com/v2/post/publish/video/init/", { method: "POST", headers: auth, body: JSON.stringify({
    post_info: { title: captionFor(plan, "tiktok", { salesOpen: plan.salesOpen === true }), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false, is_aigc: true, brand_content_toggle: false, brand_organic_toggle: true },
    source_info: { source: "FILE_UPLOAD", video_size: mp4.length, chunk_size: mp4.length, total_chunk_count: 1 } }) }), "tiktok_init");
  const publishId = init?.data?.publish_id, upload = init?.data?.upload_url;
  if (!publishId || !upload) throw new Error("tiktok_init_incomplete");
  const put = await fetchImpl(upload, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(mp4.length), "content-range": `bytes 0-${mp4.length - 1}/${mp4.length}` }, body: mp4 });
  if (!put.ok) throw new Error("tiktok_upload_http_" + put.status);
  for (let i = 0; i < 30; i++) {
    const st = await jsonOrThrow(await fetchImpl("https://open.tiktokapis.com/v2/post/publish/status/fetch/", { method: "POST", headers: auth, body: JSON.stringify({ publish_id: publishId }) }), "tiktok_status");
    const s = st?.data?.status;
    if (s === "PUBLISH_COMPLETE") { const id = (st.data.publicaly_available_post_id || st.data.publicly_available_post_id || [])[0]; return { provider_post_id: String(id || publishId), privacy, url: null }; }
    if (s === "FAILED") throw new Error("tiktok_publish_failed_" + String(st?.data?.fail_reason || "unknown").replace(/[^a-z0-9_]/gi, "").slice(0, 40));
    await sleep(5000);
  }
  throw new Error("tiktok_publish_timeout");
}

// Instagram Reels: container from the public video URL, wait until FINISHED, publish.
export async function publishInstagramReel(plan, videoUrl, { token, igId, fetchImpl = fetch, sleep = sleepMs }) {
  const c = await jsonOrThrow(await fetchImpl(`${GRAPH}/${igId}/media`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption: captionFor(plan, "instagram", { salesOpen: plan.salesOpen === true }), share_to_feed: true, access_token: token }) }), "instagram_container");
  if (!c?.id) throw new Error("instagram_container_missing");
  for (let i = 0; i < 40; i++) {
    const st = await jsonOrThrow(await fetchImpl(`${GRAPH}/${c.id}?fields=status_code&access_token=${encodeURIComponent(token)}`), "instagram_status");
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("instagram_container_" + st.status_code.toLowerCase());
    if (i === 39) throw new Error("instagram_container_timeout");
    await sleep(5000);
  }
  const pub = await jsonOrThrow(await fetchImpl(`${GRAPH}/${igId}/media_publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creation_id: c.id, access_token: token }) }), "instagram_publish");
  if (!pub?.id) throw new Error("instagram_publish_missing");
  const link = await fetchImpl(`${GRAPH}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).then(r => r.json()).catch(() => ({}));
  return { provider_post_id: String(pub.id), url: link?.permalink || null };
}

// Facebook Page video (Reels-eligible vertical video) via direct file upload.
export async function publishFacebookVideo(plan, mp4, { token, pageId, fetchImpl = fetch }) {
  const form = new FormData();
  form.set("access_token", token); form.set("description", captionFor(plan, "facebook", { salesOpen: plan.salesOpen === true })); form.set("title", plan.title.slice(0, 95));
  form.set("source", new Blob([mp4], { type: "video/mp4" }), "zevanory-short.mp4");
  const out = await jsonOrThrow(await fetchImpl(`https://graph-video.facebook.com/v21.0/${pageId}/videos`, { method: "POST", body: form }), "facebook_video");
  if (!out?.id) throw new Error("facebook_video_missing");
  return { provider_post_id: String(out.id), url: `https://www.facebook.com/${pageId}/videos/${out.id}` };
}

// Telegram channel: the same vertical video, native player (no external link preview needed).
export async function publishTelegramVideo(plan, mp4, { token, chatId, fetchImpl = fetch }) {
  const form = new FormData();
  form.set("chat_id", chatId); form.set("caption", captionFor(plan, "telegram", { salesOpen: plan.salesOpen === true }).slice(0, 1024)); form.set("supports_streaming", "true");
  form.set("video", new Blob([mp4], { type: "video/mp4" }), "zevanory-" + plan.day + ".mp4");
  const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendVideo`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok !== true || !j?.result?.message_id) throw new Error("telegram_video_http_" + r.status);
  const handle = String(j.result.chat?.username || "");
  return { provider_post_id: String(j.result.message_id), url: handle ? `https://t.me/${handle}/${j.result.message_id}` : null };
}

export async function crosspost({ day, slot = "oferta", mp4, env = process.env, kv, fetchImpl = fetch, sleep = sleepMs, now = Date.now(), salesOpen, approvedPlan = null }) {
  const open = approvedPlan ? approvedPlan.salesOpen === true : typeof salesOpen === "boolean" ? salesOpen : await channelSalesOpen(kv);
  const plan = approvedPlan || { ...planSlot(day, slot, { salesOpen: open }), salesOpen: open }, report = {}, sfx = slot === "oferta" ? "" : "_" + slot, mediaId = slot === "oferta" ? day : day + "-" + slot;
  const done = async ch => { const v = await kv.get(`zpc:acquisition:daily:${day}:${ch}${sfx}`); return v ? JSON.parse(v) : null; };
  const record = async (ch, r) => {
    await kv.put(`zpc:acquisition:daily:${day}:${ch}${sfx}`, JSON.stringify({ channel: ch, day, status: "publicado", provider_post_id: r.provider_post_id, url: r.url, privacy: r.privacy || "public", product: plan.entry.product.sku, at: new Date(now).toISOString() }), { expirationTtl: 400 * 86400 });
    await emitActivity({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { type: "post_published", channel: ch, status: r.privacy === "SELF_ONLY" ? "private" : "published", ref: `${ch}:${day}:${sfx ? slot + ":" : ""}${plan.entry.theme_id}`, link: r.url || "" }, { now });
  };
  // Media URL for pull-based platforms.
  await kv.putBinary(`zpc:media:short:${mediaId}`, mp4, { expirationTtl: 30 * 86400 });
  const videoUrl = `https://zevanory.api.br/media/short/${mediaId}.mp4`;
  // TikTok
  try {
    if (slot !== "oferta") report.tiktok = "scheduled_via_pack";
    else if (await done("tiktok")) report.tiktok = "already_published";
    else {
      const access = await getPublisherAccessToken("tiktok", env.TIKTOK_CLIENT_SECRET, fetchImpl);
      if (!access.connected) report.tiktok = "waiting:" + access.reason;
      else { const r = await publishTikTok(plan, mp4, { token: access.token, audited: env.TIKTOK_AUDIT_APPROVED === "true", fetchImpl, sleep }); await record("tiktok", r); report.tiktok = "published:" + r.privacy; }
    }
  } catch (e) { report.tiktok = "error:" + String(e.message).slice(0, 80); }
  // Telegram channel video
  try {
    const tgToken = String(env.TELEGRAM_BOT_TOKEN || "").trim(), tgChat = String(env.TELEGRAM_CHANNEL_ID || "").trim();
    if (slot !== "oferta") report.telegram_video = "offer_slot_only";
    else if (await done("telegram_video")) report.telegram_video = "already_published";
    else if (!tgToken || !tgChat) report.telegram_video = "waiting:telegram_credentials";
    else { const r = await publishTelegramVideo(plan, mp4, { token: tgToken, chatId: tgChat, fetchImpl }); await record("telegram_video", r); report.telegram_video = "published"; }
  } catch (e) { report.telegram_video = "error:" + String(e.message).replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot***").slice(0, 80); }
  // Meta (Instagram Reels + Facebook Page)
  const metaToken = String(env.META_ACCESS_TOKEN || "").trim(), igId = String(env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "").trim(), pageId = String(env.META_PAGE_ID || "").trim();
  for (const [ch, ready, run] of [
    ["instagram", metaToken && igId, () => publishInstagramReel(plan, videoUrl, { token: metaToken, igId, fetchImpl, sleep })],
    ["facebook", metaToken && pageId, () => publishFacebookVideo(plan, mp4, { token: metaToken, pageId, fetchImpl })]]) {
    try {
      if (await done(ch)) { report[ch] = "already_published"; continue; }
      if (!ready) { report[ch] = "waiting:meta_credentials"; continue; }
      const r = await run(); await record(ch, r); report[ch] = "published";
    } catch (e) { report[ch] = "error:" + String(e.message).slice(0, 80); }
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const day = (process.argv.find(a => a.startsWith("--day=")) || "").slice(6) || localDay();
  const slotArg = (process.argv.find(a => a.startsWith("--slot=")) || "").slice(7) || "oferta";
  const kv = cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID });
  let errors = 0;
  for (const slot of slotArg === "all" ? ["dica", "oferta", "calc"] : [slotArg]) {
    const window = publicationWindow({ day, slot, now: Date.now() });
    if (window.action !== "publish") { console.log(`::notice title=SHORT_CROSSPOST::${slot}=skipped_${window.reason}`); continue; }
    const file = "/tmp/zevanory-daily-short" + (slot === "oferta" ? "" : "-" + slot) + ".mp4";
    // P05: only a file sealed by a PASS of zevanory-av-gate for exactly these bytes may be cross-posted.
    if (!(await avGateSealed(file))) { console.log(`::warning title=SHORT_CROSSPOST::${slot}=not_sealed_by_av_gate (not posted)`); continue; }
    let mp4; try { mp4 = await readFile(file); } catch { console.log(`::warning title=SHORT_CROSSPOST::${slot}=no_rendered_file`); continue; }
    // P05: cross-post with the APPROVED bundle metadata (title, description, captions), verified by hash.
    let approvedPlan = null;
    try {
      const seal = JSON.parse(await readFile(file.replace(/\.mp4$/, ".av-gate.json"), "utf8"));
      const bb = await kv.getBinary(CANDIDATE_PREFIX + "bundle:" + seal.bundle_sha256);
      if (!bb || createHash("sha256").update(bb).digest("hex") !== seal.bundle_sha256) throw new Error("bundle_unverified");
      const b = JSON.parse(Buffer.from(bb).toString("utf8"));
      approvedPlan = { day: b.day, slot: b.slot, marker: b.marker, title: b.title, description: b.description, tags: b.tags, privacyStatus: b.privacy, link: b.link, salesOpen: b.sales_open === true,
        entry: { theme_id: b.theme_id, product: { sku: b.product_sku, name: b.product_name } }, screen: b.screen || {}, persistedCaptions: b.captions || {} };
    } catch (e) { console.log(`::warning title=SHORT_CROSSPOST::${slot}=approved_bundle_unavailable (not posted)`); continue; }
    const report = await crosspost({ day, slot, mp4, kv, approvedPlan });
    for (const [ch, v] of Object.entries(report)) { if (v.startsWith("error")) errors++; console.log(`::${v.startsWith("error") ? "error" : "notice"} title=SHORT_CROSSPOST::${slot}:${ch}=${String(v).replace(/[\r\n]+/g, " ")}`); }
  }
  if (errors) process.exit(1);
}
