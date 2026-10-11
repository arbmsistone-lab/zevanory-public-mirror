// P1-5: autonomous daily YouTube Short (scheduled GitHub Actions job; Workers Free
// cannot render video). One Short per local day from the content calendar, with
// the official brand template, F1 creative gate, idempotent upload (marker in the
// description), UNLISTED while Google's API audit is pending (YouTube itself keeps
// uploads from unaudited projects private), and a masked post_published record in
// the shared activity outbox. Tokens come from the OAuth bridge; nothing secret is
// logged. Usage: node youtube-daily-short.mjs [--dry-run] [--day=YYYY-MM-DD]
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { calendarEntry, productLink } from "../../worker/acquisition-engine.mjs";
import { evaluateCreativeWithRewrites } from "../../worker/creative-autonomy.mjs";
import { emitActivity } from "../../worker/activity-ledger.mjs";

export const TARGET_CHANNEL = "UCMl8-SxMVv77S2tz2H63P3A";
export const PRICES = Object.freeze({ "ZEV-IA-011": 197, "ZEV-VEN-011": 197, "ZEV-LCX-011": 247, "ZEV-CMB-011": 297, "ZEV-NGC-011": 397 });
const NICHE_LABEL = { "salão": "salões de beleza", "loja": "lojas de bairro", "prestador de serviço": "prestadores de serviço", "delivery": "negócios de delivery", "autônomo": "profissionais autônomos" };
const ANGLE_HOOK = { "dor": "Menos retrabalho", "tutorial": "Passo a passo", "caso de uso": "Um caso prático", "objeção": "Sem tempo para organizar?", "comparação": "Manual ou assistido?" };
const ANGLE_LINE = {
  "dor": "Anote onde você refaz o mesmo trabalho toda semana.",
  "tutorial": "Escolha uma tarefa pequena e revise cada resultado.",
  "caso de uso": "Teste com dados fictícios antes de mudar a rotina.",
  "objeção": "Comece com 15 minutos por semana, sem parar a operação.",
  "comparação": "Compare tempo, erros e facilidade de desfazer."
};
export const localDay = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export function planShort(day) {
  const entry = calendarEntry(day), price = PRICES[entry.product.sku];
  if (!price) throw new Error("youtube_price_unknown");
  const niche = NICHE_LABEL[entry.niche];
  const hook = ANGLE_HOOK[entry.angle] + " para " + niche;
  const spec = { creative_id: "youtube-short-" + day, brand: "ZEVANORY", site: "zevanory.api.br", width: 1080, height: 1920, hook, body: entry.product.name + " por R$ " + price + ",00. Garantia de 7 dias.", cta: "Veja o guia digital", price_brl: price };
  const gate = evaluateCreativeWithRewrites(spec, { serverPrice: price, visualScore: 1 });
  const link = productLink(entry, "blog").replace("utm_source=blog", "utm_source=youtube");
  const marker = "zevanory-short-key:" + createHash("sha256").update(day + "|" + entry.theme_id + "|short-v1").digest("hex").slice(0, 16);
  const title = (ANGLE_HOOK[entry.angle] + " para " + niche + " · " + entry.product.name).slice(0, 95);
  const description = [
    ANGLE_LINE[entry.angle] + " Um guia prático da ZEVANORY para " + niche + ", com revisão humana e sem promessas de faturamento.",
    "",
    entry.product.name + " — R$ " + price + ",00 · Garantia de 7 dias: " + link,
    "",
    "#Shorts #ZEVANORY #PequenosNegocios",
    "",
    marker
  ].join("\n");
  const lines = [ANGLE_HOOK[entry.angle], "Para " + niche, "", entry.product.name, "Garantia de 7 dias"];
  const speech = [hook + ".", ANGLE_LINE[entry.angle], entry.product.name + ", garantia de sete dias.", "Veja o guia digital no link."].join(" ");
  return { day, entry, price, spec, gate, link, marker, title, description, lines, speech, privacyStatus: "unlisted" };
}

const run = (cmd, args) => { const p = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); if (p.status !== 0) throw new Error(cmd + "_failed"); return p.stdout; };

async function geminiSpeech(text, key) {
  if (!key) return null;
  const STYLE = "Fale em português do Brasil, com voz natural, acolhedora, clara e profissional, em ritmo de conversa.";
  for (const model of ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model, input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }], response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 }, generation_config: { speech_config: [{ voice: "Achird" }] } }), signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (!r?.ok) continue;
    const body = await r.json().catch(() => ({}));
    const part = (body.steps || []).filter(x => x.type === "model_output").flatMap(x => x.content || []).find(x => x.type === "audio" && x.data);
    if (!part) continue;
    const rate = Number(part.sample_rate || (String(part.mime_type || "").match(/rate=(\d+)/) || [])[1]) || 24000;
    return { pcm: Buffer.from(part.data, "base64"), rate, model };
  }
  return null;
}

export async function renderShort(plan, base = "/tmp/zevanory-daily-short", { geminiKey = process.env.GEMINI_API_KEY } = {}) {
  await writeFile(base + ".txt", plan.lines.join("\n"));
  const voice = await geminiSpeech(plan.speech, geminiKey);
  let audioInput;
  if (voice && voice.pcm.length >= voice.rate) {
    await writeFile(base + ".pcm", voice.pcm);
    run("ffmpeg", ["-y", "-f", "s16le", "-ar", String(voice.rate), "-ac", "1", "-i", base + ".pcm", "-c:a", "libmp3lame", "-b:a", "128k", base + ".mp3"]);
    audioInput = ["-i", base + ".mp3"];
  } else {
    audioInput = ["-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=24000"];
  }
  const template = "assets/brand/export/short.png";
  const vf = "scale=1080:1920,drawbox=x=62:y=1150:w=956:h=500:color=0x0c1c2b@0.92:t=fill,drawtext=textfile=" + base + ".txt:fontcolor=white:fontsize=58:line_spacing=22:x=(w-text_w)/2:y=1205";
  run("ffmpeg", ["-y", "-loop", "1", "-framerate", "30", "-i", template, ...audioInput, "-filter_complex", "[0:v]" + vf + "[v];[1:a]" + (voice ? "loudnorm=I=-16:TP=-1.5:LRA=11," : "") + "apad[a]", "-map", "[v]", "-map", "[a]", "-t", "20", "-c:v", "libx264", "-r", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", base + ".mp4"]);
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", base + ".mp4"]));
  const v = probe.streams.find(s => s.codec_type === "video"), a = probe.streams.find(s => s.codec_type === "audio"), duration = Number(probe.format.duration);
  if (!v || v.width !== 1080 || v.height !== 1920 || !a || !(duration >= 19 && duration <= 21)) throw new Error("youtube_mp4_technical_gate_failed");
  const black = spawnSync("ffmpeg", ["-hide_banner", "-i", base + ".mp4", "-vf", "blackdetect=d=0.6:pix_th=0.02", "-an", "-f", "null", "-"], { encoding: "utf8" });
  if (black.status !== 0 || /black_start:/.test(black.stderr)) throw new Error("youtube_black_frames_detected");
  return { file: base + ".mp4", duration, voice: voice ? voice.model : "none" };
}

// Cloudflare KV REST adapter so the CI job writes the exact emitActivity schema.
export function cloudflareKv({ token, account, namespace, fetchImpl = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/`;
  const auth = { authorization: "Bearer " + token };
  return {
    async get(key) { const r = await fetchImpl(base + encodeURIComponent(key), { headers: auth }); if (r.status === 404) return null; if (!r.ok) throw new Error("kv_get_http_" + r.status); return await r.text(); },
    async put(key, value, opts = {}) { const q = opts.expirationTtl ? "?expiration_ttl=" + Number(opts.expirationTtl) : ""; const r = await fetchImpl(base + encodeURIComponent(key) + q, { method: "PUT", headers: { ...auth, "content-type": "text/plain" }, body: String(value) }); if (!r.ok) throw new Error("kv_put_http_" + r.status); }
  };
}

export async function publishShort(plan, mp4, { accessToken, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const auth = { authorization: "Bearer " + accessToken };
  const chRes = await fetchImpl("https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&mine=true", { headers: auth });
  const ch = await chRes.json().catch(() => ({}));
  if (!chRes.ok || ch.items?.length !== 1 || ch.items[0].id !== TARGET_CHANNEL) throw new Error("youtube_channel_id_mismatch");
  const uploads = ch.items[0].contentDetails?.relatedPlaylists?.uploads;
  let videoId = "";
  if (uploads) {
    const pl = await (await fetchImpl(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(uploads)}`, { headers: auth })).json().catch(() => ({}));
    videoId = (pl.items || []).find(i => String(i.snippet?.description || "").includes(plan.marker))?.snippet?.resourceId?.videoId || "";
  }
  const reused = Boolean(videoId);
  if (!reused) {
    const metadata = { snippet: { title: plan.title, description: plan.description, tags: ["ZEVANORY", "Shorts", "pequenos negócios", plan.entry.product.name], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" }, status: { privacyStatus: plan.privacyStatus, selfDeclaredMadeForKids: false, containsSyntheticMedia: true } };
    const start = await fetchImpl("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { ...auth, "content-type": "application/json; charset=utf-8", "x-upload-content-type": "video/mp4", "x-upload-content-length": String(mp4.length) }, body: JSON.stringify(metadata) });
    const location = start.headers?.get?.("location");
    if (!start.ok || !location) throw new Error("youtube_resumable_start_http_" + start.status);
    const put = await fetchImpl(location, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(mp4.length) }, body: mp4 });
    const pj = await put.json().catch(() => ({}));
    if (!put.ok || !pj.id) throw new Error("youtube_upload_http_" + put.status);
    videoId = pj.id;
  }
  let v = null;
  for (let i = 0; i < 45; i++) {
    const r = await (await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`, { headers: auth })).json().catch(() => ({}));
    v = r.items?.[0];
    const ps = v?.processingDetails?.processingStatus, us = v?.status?.uploadStatus;
    if (ps === "succeeded" || ps === "failed" || ps === "terminated" || us === "processed" || us === "rejected" || us === "failed") break;
    await sleep(20000);
  }
  if (!v) throw new Error("youtube_video_lookup_failed");
  const uploadStatus = v.status?.uploadStatus, privacy = v.status?.privacyStatus;
  if (uploadStatus !== "processed" && uploadStatus !== "uploaded") throw new Error("youtube_not_processed_" + String(uploadStatus).replace(/[^a-z]/g, ""));
  return { video_id: videoId, url: "https://www.youtube.com/shorts/" + videoId, reused, upload_status: uploadStatus, privacy_status: privacy,
    // YouTube locks uploads from unaudited API projects to private until the audit passes.
    visibility_note: privacy === plan.privacyStatus ? "as_requested" : "provider_locked_" + String(privacy || "unknown") + "_pending_api_audit" };
}

export async function recordPublication(kv, plan, result, { now = Date.now() } = {}) {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv };
  const activity = await emitActivity(env, { type: "post_published", channel: "youtube", status: result.privacy_status === "public" ? "published" : (result.privacy_status === "unlisted" ? "unlisted" : "private"), ref: "youtube:" + plan.day + ":" + plan.entry.theme_id, link: result.url }, { now });
  // Same per-day outcome key family as the acquisition engine, for the snapshot.
  await kv.put("zpc:acquisition:daily:" + plan.day + ":youtube", JSON.stringify({ channel: "youtube", day: plan.day, status: "publicado", provider_post_id: result.video_id, url: result.url, privacy: result.privacy_status, product: plan.entry.product.sku, at: new Date(now).toISOString() }), { expirationTtl: 45 * 86400 });
  await kv.put("zpc:multichannel:proof:youtube", JSON.stringify({ channel: "youtube", provider_post_id: result.video_id, url: result.url, publishedAt: new Date(now).toISOString() }), { expirationTtl: 370 * 86400 });
  return activity;
}

const note = (level, msg) => console.log(`::${level} title=YOUTUBE_DAILY_SHORT::${String(msg).replace(/[\r\n]+/g, " ")}`);
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  try {
    const dry = process.argv.includes("--dry-run");
    const day = (process.argv.find(a => a.startsWith("--day=")) || "").slice(6) || localDay();
    const plan = planShort(day);
    if (plan.gate.action !== "publish" || plan.gate.compliance !== 100 || plan.gate.score < 85) throw new Error("f1_gate_rejected");
    const rendered = await renderShort(plan);
    note("notice", JSON.stringify({ day, theme: plan.entry.theme_id, gate: { score: plan.gate.score, compliance: plan.gate.compliance }, duration: rendered.duration, voice: rendered.voice, dry_run: dry }));
    if (dry) process.exit(0);
    for (const n of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID"]) if (!process.env[n]) throw new Error("missing_" + n);
    const { getYoutubeAccessToken } = await import("./youtube-access.mjs");
    const accessToken = await getYoutubeAccessToken();
    const result = await publishShort(plan, await readFile(rendered.file), { accessToken });
    const kv = cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID });
    const activity = await recordPublication(kv, plan, result);
    note("notice", JSON.stringify({ ...result, activity_emitted: activity.emitted === true || activity.duplicate === true }));
  } catch (e) { note("error", String(e?.message || e).replace(/[^a-z0-9_:.-]/gi, "_").slice(0, 140)); process.exit(1); }
}
