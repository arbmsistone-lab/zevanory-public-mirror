// Cross-posts the day's rendered Short (same file the YouTube job uploaded) to
// TikTok, Instagram Reels and the Facebook Page. Each channel is independent,
// idempotent per local day (KV outcome key), and only counted as published on a
// provider-confirmed id. A channel without credentials/connection is reported as
// waiting, never as failure; a provider error fails the step visibly.
// Usage: node short-crosspost.mjs [--day=YYYY-MM-DD]
import { readFile } from "node:fs/promises";
import { planShort, localDay, cloudflareKv } from "./youtube-daily-short.mjs";
import { emitActivity } from "../../worker/activity-ledger.mjs";
import { getPublisherAccessToken } from "./publisher-access.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
export function captionFor(plan, channel) {
  const tags = "#pequenosnegocios #empreendedorismo #ia #zevanory";
  const base = plan.title + "\n\n" + plan.screen.tip + "\n\n" + plan.entry.product.name + " · garantia de 7 dias.";
  if (channel === "tiktok") return (base + "\nGuia completo: vendas.zevanory.api.br\n\n" + tags).slice(0, 2200);
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
    post_info: { title: captionFor(plan, "tiktok"), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false, is_aigc: true, brand_content_toggle: false, brand_organic_toggle: true },
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
  const c = await jsonOrThrow(await fetchImpl(`${GRAPH}/${igId}/media`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption: captionFor(plan, "instagram"), share_to_feed: true, access_token: token }) }), "instagram_container");
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
  form.set("access_token", token); form.set("description", captionFor(plan, "facebook")); form.set("title", plan.title.slice(0, 95));
  form.set("source", new Blob([mp4], { type: "video/mp4" }), "zevanory-short.mp4");
  const out = await jsonOrThrow(await fetchImpl(`https://graph-video.facebook.com/v21.0/${pageId}/videos`, { method: "POST", body: form }), "facebook_video");
  if (!out?.id) throw new Error("facebook_video_missing");
  return { provider_post_id: String(out.id), url: `https://www.facebook.com/${pageId}/videos/${out.id}` };
}

export async function crosspost({ day, mp4, env = process.env, kv, fetchImpl = fetch, sleep = sleepMs, now = Date.now() }) {
  const plan = planShort(day), report = {};
  const done = async ch => { const v = await kv.get(`zpc:acquisition:daily:${day}:${ch}`); return v ? JSON.parse(v) : null; };
  const record = async (ch, r) => {
    await kv.put(`zpc:acquisition:daily:${day}:${ch}`, JSON.stringify({ channel: ch, day, status: "publicado", provider_post_id: r.provider_post_id, url: r.url, privacy: r.privacy || "public", product: plan.entry.product.sku, at: new Date(now).toISOString() }), { expirationTtl: 400 * 86400 });
    await emitActivity({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { type: "post_published", channel: ch, status: r.privacy === "SELF_ONLY" ? "private" : "published", ref: `${ch}:${day}:${plan.entry.theme_id}`, link: r.url || "" }, { now });
  };
  // Media URL for pull-based platforms.
  await kv.putBinary(`zpc:media:short:${day}`, mp4, { expirationTtl: 30 * 86400 });
  const videoUrl = `https://zevanory.api.br/media/short/${day}.mp4`;
  // TikTok
  try {
    if (await done("tiktok")) report.tiktok = "already_published";
    else {
      const access = await getPublisherAccessToken("tiktok", env.TIKTOK_CLIENT_SECRET, fetchImpl);
      if (!access.connected) report.tiktok = "waiting:" + access.reason;
      else { const r = await publishTikTok(plan, mp4, { token: access.token, audited: env.TIKTOK_AUDIT_APPROVED === "true", fetchImpl, sleep }); await record("tiktok", r); report.tiktok = "published:" + r.privacy; }
    }
  } catch (e) { report.tiktok = "error:" + String(e.message).slice(0, 80); }
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
  const kv = cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID });
  const report = await crosspost({ day, mp4: await readFile("/tmp/zevanory-daily-short.mp4"), kv });
  for (const [ch, v] of Object.entries(report)) console.log(`::${v.startsWith("error") ? "error" : "notice"} title=SHORT_CROSSPOST::${ch}=${String(v).replace(/[\r\n]+/g, " ")}`);
  if (Object.values(report).some(v => v.startsWith("error"))) process.exit(1);
}
