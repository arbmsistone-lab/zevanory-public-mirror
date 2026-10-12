// P1-5: autonomous daily YouTube Short (scheduled GitHub Actions job; Workers Free
// cannot render video). One Short per local day from the content calendar, with
// the official brand template, F1 creative gate, idempotent upload (marker in the
// description), PUBLIC (if YouTube locks an upload private it is reported honestly as
// provider_locked), and a masked post_published record in
// the shared activity outbox. Tokens come from the OAuth bridge; nothing secret is
// logged. Usage: node youtube-daily-short.mjs [--dry-run] [--day=YYYY-MM-DD]
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getUsage, addUsage, allow } from "./usage.mjs";
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

// Reach mix (80/20): two value Shorts a day (a practical AI tip for one of the 40
// business types, and a free calculator) plus the product Short. Value content is
// what short-video feeds distribute to new audiences; the offer converts them.
export const SLOTS = Object.freeze(["dica", "oferta", "calc"]);
const BANK = JSON.parse(readFileSync(new URL("../../data/short-bank.json", import.meta.url), "utf8"));
const dayIndex = day => Math.floor(Date.parse(day + "T12:00:00Z") / 86400000);
const VALUE_RISK = /\b(gr[aá]tis|renda garantida|lucro garantido|ganhe dinheiro|resultado garantido|fature|enrique[cç]a|antes e depois|cura|milagre|voc[eê] sofre)\b/i;
const lowerFirst = t => t.charAt(0).toLowerCase() + t.slice(1);
export function planValueShort(day, slot) {
  const i = dayIndex(day);
  let item, use, url, screen, said, title, lead, campaign;
  if (slot === "dica") {
    item = BANK.guides[((i % BANK.guides.length) + BANK.guides.length) % BANK.guides.length];
    const k0 = Math.floor(i / BANK.guides.length) % item.uses.length;
    use = ([...item.uses.slice(k0), ...item.uses.slice(0, k0)].find(u => !VALUE_RISK.test(u)) || item.uses[0]).replace(/[.\s]+$/, "");
    campaign = "dica_" + item.slug.replace(/^ia-para-/, "");
    title = "IA para " + lowerFirst(item.name) + ": 1 dica prática #shorts";
    screen = { hook: "IA para " + lowerFirst(item.name), niche: "uma dica para aplicar hoje", tip: use + ".", product: "Guia gratuito", offer: "5 usos + mensagens prontas", cta: "Link na descrição", url: "vendas.zevanory.api.br" };
    said = [["IA para " + lowerFirst(item.name) + "?", "Uma dica prática."], [use + "."], ["No guia gratuito tem mais quatro usos e mensagens prontas."], ["O link está na descrição."]];
    lead = use + ". Mais 4 usos práticos, mensagens prontas para o WhatsApp e checklist da semana no guia gratuito para " + item.plural + ".";
  } else {
    item = BANK.calculators[((i % BANK.calculators.length) + BANK.calculators.length) % BANK.calculators.length];
    campaign = "calc_" + item.slug.replace(/^calculadora-/, "");
    title = item.hook + " Calcule em segundos #shorts";
    screen = { hook: item.hook, niche: "calcule em segundos", tip: item.tip, product: item.name, offer: "Gratuita · sem cadastro", cta: "Link na descrição", url: "vendas.zevanory.api.br" };
    said = [[item.hook], [item.tip], ["Use a calculadora gratuita da ZEVANORY, sem cadastro."], ["O link está na descrição."]];
    lead = item.tip + " Faça a conta em segundos na calculadora gratuita da ZEVANORY, sem cadastro.";
  }
  url = `https://vendas.zevanory.api.br/${item.slug}?utm_source=youtube&utm_medium=short&utm_campaign=${campaign}`;
  const marker = "zevanory-short-key:" + createHash("sha256").update(day + "|" + slot + "|" + item.slug + "|short-v2").digest("hex").slice(0, 16);
  const description = [lead, "", url, "", "#Shorts #ZEVANORY #PequenosNegocios #Empreendedorismo", "", marker].join("\n");
  const speech = said.map(b => b.join(" ")).join(" ");
  const text = [screen.hook, screen.tip, speech, description].join(" ");
  const gate = VALUE_RISK.test(text) ? { action: "discard", score: 0, compliance: 0, reason: "value_risk_term" } : { action: "publish", score: 100, compliance: 100, reason: "value_gate_ok" };
  const entry = { theme_id: slot + ":" + item.slug, product: { name: screen.product, sku: null } };
  return { day, slot, entry, price: null, spec: null, gate, link: url, marker, title, description, lines: [], speech, said, screen, privacyStatus: "public", tags: ["ZEVANORY", "Shorts", "pequenos negócios", slot === "dica" ? item.name : item.name] };
}
export function planSlot(day, slot = "oferta") {
  if (!SLOTS.includes(slot)) throw new Error("short_slot_unknown");
  return slot === "oferta" ? planShort(day) : planValueShort(day, slot);
}

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
  // Spoken script, grouped by on-screen beat: 1 hook, 2 practical tip, 3 offer, 4 call to action.
  const opener = /[?!.]$/.test(ANGLE_HOOK[entry.angle]) ? ANGLE_HOOK[entry.angle] : ANGLE_HOOK[entry.angle] + ".";
  const said = [[opener, "Isso é para " + niche + "."], [ANGLE_LINE[entry.angle]], [entry.product.name + ", com garantia de sete dias."], ["Veja o guia no link da descrição."]];
  const speech = said.map(b => b.join(" ")).join(" ");
  const screen = {
    hook: ANGLE_HOOK[entry.angle], niche: "para " + niche, tip: ANGLE_LINE[entry.angle],
    product: entry.product.name, offer: "R$ " + price + " · Garantia de 7 dias",
    cta: "Link na descrição", url: "vendas.zevanory.api.br"
  };
  return { day, slot: "oferta", entry, price, spec, gate, link, marker, title, description, lines, speech, said, screen, privacyStatus: "public", tags: ["ZEVANORY", "Shorts", "pequenos negócios", entry.product.name] };
}

const run = (cmd, args) => { const p = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); if (p.status !== 0) throw new Error(cmd + "_failed"); return p.stdout; };

async function geminiSpeech(text, key) {
  if (!key) { console.log("::warning title=SHORT_VOICE::gemini not used; trying the free local voice"); return piperSpeech(text); }
  const STYLE = "Fale em português do Brasil, com voz natural, acolhedora, clara e profissional, em ritmo de conversa.";
  const errors = [];
  // Modern Interactions API first, then the classic generateContent TTS models.
  const chain = [["gemini-3.8-flash-tts", true], ["gemini-3.8-flash-lite-tts", true], ["gemini-3.1-flash-tts-preview", false], ["gemini-2.5-flash-preview-tts", false]];
  for (const [model, modern] of chain) {
    const url = modern ? "https://generativelanguage.googleapis.com/v1beta/interactions" : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = modern
      ? { model, input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }], response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 }, generation_config: { speech_config: [{ voice: "Achird" }] } }
      : { contents: [{ parts: [{ text: STYLE + "\n\n" + text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Achird" } } } } };
    const r = await fetch(url, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }).catch((e) => ({ ok: false, status: "fetch_" + (e?.name || "error") }));
    if (!r?.ok) { errors.push(model + ":" + r?.status); continue; }
    const json = await r.json().catch(() => ({}));
    const part = modern
      ? (json.steps || []).filter((x) => x.type === "model_output").flatMap((x) => x.content || []).find((x) => x.type === "audio" && x.data)
      : (json?.candidates?.[0]?.content?.parts || []).find((x) => x?.inlineData?.data || x?.inline_data?.data);
    const data = part?.data || part?.inlineData?.data || part?.inline_data?.data;
    if (!data) { errors.push(model + ":no_audio"); continue; }
    const mime = String(part?.mime_type || part?.inlineData?.mimeType || part?.inline_data?.mime_type || "");
    const rate = Number(part?.sample_rate || (mime.match(/rate=(\d+)/i) || [])[1]) || 24000;
    console.log("::notice title=SHORT_VOICE::" + model + " ok");
    return { pcm: Buffer.from(data, "base64"), rate, model };
  }
  // Only provider status codes, never the key.
  console.log("::warning title=SHORT_VOICE::gemini unavailable (" + errors.join(", ") + "); trying the free local voice");
  return piperSpeech(text);
}

// Free, local, open-source neural voice (Piper, pt_BR). Zero cost; used when the Gemini free
// quota is exhausted or unavailable.
export function piperSpeech(text, model = process.env.PIPER_MODEL) {
  if (!model) { console.log("::warning title=SHORT_VOICE::no narration (piper model absent)"); return null; }
  const p = spawnSync("piper", ["--model", model, "--output_raw"], { input: text, maxBuffer: 64 * 1024 * 1024 });
  if (p.status !== 0 || !p.stdout?.length) { console.log("::warning title=SHORT_VOICE::no narration (piper failed)"); return null; }
  let rate = 22050;
  try { rate = JSON.parse(readFileSync(model + ".json", "utf8"))?.audio?.sample_rate || 22050; } catch {}
  console.log("::notice title=SHORT_VOICE::piper ok");
  return { pcm: Buffer.from(p.stdout), rate, model: "piper-local" };
}

// Retention-first Short (YouTube scores watch-through): the hook is big at the top
// from frame 0, the length follows the narration (no dead air), the background
// slowly pushes in, a card changes with each spoken beat (tip -> offer -> call to
// action) at the real sentence boundaries detected in the voice track, and a
// progress bar runs along the bottom. Captions double as subtitles for muted viewers.
export function shortTiming(voiceSeconds, lineCount) {
  const speech = Number.isFinite(voiceSeconds) && voiceSeconds > 0 ? voiceSeconds : 0;
  const duration = speech ? Math.min(20, Math.max(8, Math.ceil((speech + 1.2) * 10) / 10)) : 12;
  const span = Math.min(speech || duration, duration) * 0.8;
  const reveal = Array.from({ length: lineCount }, (_, i) => Math.round((lineCount > 1 ? (i * span) / (lineCount - 1) : 0) * 100) / 100);
  return { duration, reveal };
}
// Beat start times: expected positions come from each beat's share of the script;
// each is snapped to the nearest real pause in the voice (±1.5 s), never reordered.
export function beatTimes(said, speechSeconds, pauses = [], duration) {
  const chars = said.map(b => b.join(" ").length), total = chars.reduce((a, b) => a + b, 0) || 1;
  const span = speechSeconds > 0 ? speechSeconds : duration * 0.85;
  const starts = [0];
  let acc = 0;
  for (let i = 1; i < said.length; i++) {
    acc += chars[i - 1];
    const expected = (acc / total) * span;
    const near = pauses.filter(p => Math.abs(p - expected) <= 1.5 && p > starts[i - 1] + 0.6).sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
    starts.push(Math.round(Math.min(duration - 0.8, near ?? expected) * 100) / 100);
  }
  return starts;
}
export function wrapText(text, maxChars, maxLines = 4) {
  const words = String(text).split(/\s+/).filter(Boolean), out = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && (last + " " + w).length <= maxChars) out[out.length - 1] = last + " " + w; else out.push(w);
  }
  return out.length <= maxLines ? out : null;
}
function fitText(text, sizes, width, ratio, maxLines, minCap = 1) {
  // Prefer the biggest size that fits in the fewest lines (2 before 3...); minCap
  // lets body copy use more lines at a bigger, more legible size.
  for (let cap = Math.min(minCap, maxLines); cap <= maxLines; cap++) for (const size of sizes) { const lines = wrapText(text, Math.floor(width / (size * ratio)), cap); if (lines) return { size, lines }; }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrapText(text, Math.floor(width / (size * ratio)), 99) };
}
const fontFile = (style, fallback) => {
  const p = spawnSync("fc-match", ["-f", "%{file}", "Inter:style=" + style], { encoding: "utf8" });
  const f = String(p.stdout || "").trim();
  return /inter/i.test(f) ? f : fallback;
};
function voicePauses(file) {
  const p = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=n=-35dB:d=0.22", "-f", "null", "-"], { encoding: "utf8" });
  return [...String(p.stderr || "").matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]));
}
export async function renderShort(plan, base = "/tmp/zevanory-daily-short", { geminiKey = process.env.GEMINI_API_KEY } = {}) {
  const voice = await geminiSpeech(plan.speech, geminiKey);
  let audioInput, voiceSeconds = 0, pauses = [];
  if (voice && voice.pcm.length >= voice.rate) {
    voiceSeconds = voice.pcm.length / 2 / voice.rate;
    await writeFile(base + ".pcm", voice.pcm);
    run("ffmpeg", ["-y", "-f", "s16le", "-ar", String(voice.rate), "-ac", "1", "-i", base + ".pcm", "-c:a", "libmp3lame", "-b:a", "128k", base + ".mp3"]);
    audioInput = ["-i", base + ".mp3"];
    pauses = voicePauses(base + ".mp3");
  } else {
    audioInput = ["-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=24000"];
  }
  const { duration } = shortTiming(voiceSeconds, 1);
  const [, tTip, tOffer, tCta] = beatTimes(plan.said, voiceSeconds, pauses, duration);
  const XB = fontFile("ExtraBold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  const SB = fontFile("SemiBold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  const MD = fontFile("Medium", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
  // Width ratios measured on Inter for every string the calendar can produce; the
  // DejaVu fallback is wider, so it gets a wider ratio and never overflows.
  const R = /inter/i.test(XB) ? { xb: 0.58, sb: 0.54, md: 0.55 } : { xb: 0.68, sb: 0.64, md: 0.64 };
  const sc = plan.screen, draws = [];
  let n = 0;
  // Anything on screen at t=0 is fully visible on the first frame (that frame is the
  // feed preview); later beats fade in.
  const fade = (a, b) => a === 0 ? (b == null ? "" : `:enable='lt(t,${b})'`) : b == null ? `:alpha='min(1,max(0,(t-${a})/0.18))'` : `:alpha='if(between(t,${a},${b}),min(1,(t-${a})/0.18),0)'`;
  // y is the baseline: every line of a block sits on an even rhythm regardless of glyphs.
  const text = async (str, font, size, color, baseline, a, b, center = true, x = 96) => {
    const file = `${base}.t${n++}.txt`;
    await writeFile(file, str);
    draws.push(`drawtext=fontfile=${font}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${center ? "(w-text_w)/2" : x}:y=${baseline}-ascent${fade(a, b)}`);
  };
  // Hook block (top), visible from the first frame.
  const hook = fitText(sc.hook, [120, 112, 104, 96, 88], 900, R.xb, 3);
  let y = 270;
  for (const line of hook.lines) { y += Math.round(hook.size * 1.08); await text(line, XB, hook.size, "0xf5f7fb", y, 0, null, false); }
  const niche = fitText(sc.niche, [62, 56, 50], 900, R.sb, 2);
  y += 14;
  for (const line of niche.lines) { y += Math.round(niche.size * 1.3); await text(line, SB, niche.size, "0x8fb8ff", y, 0, null, false); }
  // Card beats, vertically centred in the card (y 1000..1600).
  const block = async (items, a, b) => {
    const h = items.reduce((s, it) => s + it.lines.length * Math.round(it.size * 1.25) + (it.gap || 0), 0);
    let cy = 1300 - Math.round(h / 2);
    for (const it of items) { cy += it.gap || 0; for (const line of it.lines) { cy += Math.round(it.size * 1.25); await text(line, it.font, it.size, it.color, cy - Math.round(it.size * 0.25), a, b); } }
  };
  // Beat 1: the card is never empty; it promises the payoff while the hook is spoken.
  await block([{ ...fitText("1 dica prática", [84, 76], 820, R.xb, 1), font: XB, color: "0x8fb8ff" }, { ...fitText("para aplicar ainda hoje", [52, 46], 820, R.sb, 1), font: SB, color: "0xf5f7fb", gap: 18 }], 0, tTip);
  const tip = fitText(sc.tip, [66, 60, 54, 48], 820, R.md, 5, 3);
  await block([{ ...tip, font: MD, color: "0xf5f7fb" }], tTip, tOffer);
  const prod = fitText(sc.product, [88, 80, 72], 820, R.xb, 2), offer = fitText(sc.offer, [52, 46], 820, R.sb, 2);
  await block([{ ...prod, font: XB, color: "0xf5f7fb" }, { ...offer, font: SB, color: "0xa8f0d0", gap: 22 }], tOffer, tCta);
  const cta = fitText(sc.cta, [84, 76, 68], 820, R.xb, 2), url = fitText(sc.url, [52, 46], 820, R.sb, 1);
  await block([{ ...cta, font: XB, color: "0x21e6f3" }, { ...url, font: SB, color: "0xf5f7fb", gap: 26 }], tCta, null);
  const template = "assets/brand/export/short.png";
  const frames = Math.round(duration * 30);
  const vf = [
    "scale=1080:1920",
    "drawbox=x=56:y=600:w=968:h=560:color=0x0b0f16:t=fill", // clear the template's static headline
    `zoompan=z='1+0.04*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`,
    "drawbox=x=96:y=228:w=220:h=8:color=0x00b8ff:t=fill",
      "drawbox=x=76:y=1000:w=928:h=600:color=0x0c1c2b@0.95:t=fill",
    "drawbox=x=76:y=1000:w=10:h=600:color=0x00b8ff:t=fill",
    ...draws
  ].join(",");
  // Progress bar: a cyan strip slides into an 888x10 track (overlay clips it), then
  // the track is placed on the frame; drawbox sizes are not per-frame on all ffmpeg builds.
  const bar = `color=c=0x202a38:s=888x10:r=30:d=${duration}[track];color=c=0x00b8ff:s=888x10:r=30:d=${duration}[fill];[track][fill]overlay=x='-888+888*t/${duration}':y=0:shortest=1[bar];[base][bar]overlay=x=96:y=1724:shortest=1[v]`;
  run("ffmpeg", ["-y", "-loop", "1", "-framerate", "30", "-i", template, ...audioInput, "-filter_complex", "[0:v]" + vf + "[base];" + bar + ";[1:a]" + (voice ? "loudnorm=I=-16:TP=-1.5:LRA=11," : "") + "apad[a]", "-map", "[v]", "-map", "[a]", "-t", String(duration), "-c:v", "libx264", "-r", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", base + ".mp4"]);
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", base + ".mp4"]));
  const v = probe.streams.find(s => s.codec_type === "video"), a = probe.streams.find(s => s.codec_type === "audio"), real = Number(probe.format.duration);
  if (!v || v.width !== 1080 || v.height !== 1920 || !a || !(Math.abs(real - duration) <= 0.5)) throw new Error("youtube_mp4_technical_gate_failed");
  const black = spawnSync("ffmpeg", ["-hide_banner", "-i", base + ".mp4", "-vf", "blackdetect=d=0.6:pix_th=0.02", "-an", "-f", "null", "-"], { encoding: "utf8" });
  if (black.status !== 0 || /black_start:/.test(black.stderr)) throw new Error("youtube_black_frames_detected");
  return { file: base + ".mp4", duration: real, voice: voice ? voice.model : "none", beats: { tip: tTip, offer: tOffer, cta: tCta } };
}

// Cloudflare KV REST adapter so the CI job writes the exact emitActivity schema.
export function cloudflareKv({ token, account, namespace, fetchImpl = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/`;
  const auth = { authorization: "Bearer " + token };
  return {
    async get(key) { const r = await fetchImpl(base + encodeURIComponent(key), { headers: auth }); if (r.status === 404) return null; if (!r.ok) throw new Error("kv_get_http_" + r.status); return await r.text(); },
    async putBinary(key, bytes, opts = {}) { const q = opts.expirationTtl ? "?expiration_ttl=" + Number(opts.expirationTtl) : ""; const r = await fetchImpl(base + encodeURIComponent(key) + q, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body: bytes }); if (!r.ok) throw new Error("kv_put_http_" + r.status); },
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
    const metadata = { snippet: { title: plan.title, description: plan.description, tags: plan.tags || ["ZEVANORY", "Shorts"], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" }, status: { privacyStatus: plan.privacyStatus, selfDeclaredMadeForKids: false, containsSyntheticMedia: true } };
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
  const activity = await emitActivity(env, { type: "post_published", channel: "youtube", status: result.privacy_status === "public" ? "published" : (result.privacy_status === "unlisted" ? "unlisted" : "private"), ref: "youtube:" + plan.day + ":" + (plan.slot && plan.slot !== "oferta" ? plan.slot + ":" : "") + plan.entry.theme_id, link: result.url }, { now });
  // Same per-day outcome key family as the acquisition engine, for the snapshot.
  await kv.put("zpc:acquisition:daily:" + plan.day + ":youtube" + (plan.slot && plan.slot !== "oferta" ? "_" + plan.slot : ""), JSON.stringify({ channel: "youtube", slot: plan.slot || "oferta", day: plan.day, status: "publicado", provider_post_id: result.video_id, url: result.url, privacy: result.privacy_status, product: plan.entry.product.sku, at: new Date(now).toISOString() }), { expirationTtl: 45 * 86400 });
  await kv.put("zpc:multichannel:proof:youtube", JSON.stringify({ channel: "youtube", provider_post_id: result.video_id, url: result.url, publishedAt: new Date(now).toISOString() }), { expirationTtl: 370 * 86400 });
  return activity;
}

const note = (level, msg) => console.log(`::${level} title=YOUTUBE_DAILY_SHORT::${String(msg).replace(/[\r\n]+/g, " ")}`);
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const dry = process.argv.includes("--dry-run");
  const day = (process.argv.find(a => a.startsWith("--day=")) || "").slice(6) || localDay();
  const slotArg = (process.argv.find(a => a.startsWith("--slot=")) || "").slice(7) || "oferta";
  const slots = slotArg === "all" ? SLOTS : [slotArg];
  let failed = 0;
  for (const slot of slots) {
    try {
      const plan = planSlot(day, slot);
      if (plan.gate.action !== "publish" || plan.gate.compliance !== 100 || plan.gate.score < 85) throw new Error("f1_gate_rejected");
      const base = "/tmp/zevanory-daily-short" + (slot === "oferta" ? "" : "-" + slot);
      const usageKv = process.env.CLOUDFLARE_API_TOKEN ? cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID }) : null;
      const usage = usageKv ? await getUsage(usageKv) : {};
      const geminiAllowed = process.env.FORCE_LOCAL_VOICE !== "true" && allow(usage, "gemini_tts_calls", 4);
      if (!geminiAllowed) note("warning", "zero-cost guard: gemini daily guard reached, using the free local voice");
      const rendered = await renderShort(plan, base, { geminiKey: geminiAllowed ? process.env.GEMINI_API_KEY : "" });
      if (usageKv && String(rendered.voice).startsWith("gemini")) await addUsage(usageKv, "gemini_tts_calls", 1).catch(() => null);
      note("notice", JSON.stringify({ day, slot, theme: plan.entry.theme_id, gate: { score: plan.gate.score, compliance: plan.gate.compliance }, duration: rendered.duration, voice: rendered.voice, dry_run: dry }));
      if (dry) continue;
      for (const n of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID"]) if (!process.env[n]) throw new Error("missing_" + n);
      const { getYoutubeAccessToken } = await import("./youtube-access.mjs");
      const accessToken = await getYoutubeAccessToken();
      const kv = cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID });
      if (!allow(await getUsage(kv), "youtube_units", 1700)) throw new Error("zero_cost_guard_youtube_quota");
      const result = await publishShort(plan, await readFile(rendered.file), { accessToken });
      await addUsage(kv, "youtube_units", result.reused ? 5 : 1650).catch(() => null);
      const activity = await recordPublication(kv, plan, result);
      note("notice", JSON.stringify({ slot, ...result, activity_emitted: activity.emitted === true || activity.duplicate === true }));
    } catch (e) { failed++; note("error", slot + ":" + String(e?.message || e).replace(/[^a-z0-9_:.-]/gi, "_").slice(0, 140)); }
  }
  if (failed) process.exit(1);
}
