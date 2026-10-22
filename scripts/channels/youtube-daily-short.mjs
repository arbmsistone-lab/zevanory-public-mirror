// P1-5: autonomous daily YouTube Short (scheduled GitHub Actions job; Workers Free
// cannot render video). One Short per local day from the content calendar, with
// the official brand template, F1 creative gate, idempotent upload (marker in the
// description), PUBLIC (if YouTube locks an upload private it is reported honestly as
// provider_locked), and a masked post_published record in
// the shared activity outbox. Tokens come from the OAuth bridge; nothing secret is
// logged. Usage: node youtube-daily-short.mjs [--dry-run] [--day=YYYY-MM-DD]
//
// P05 (zevanory-av-gate): nothing is uploaded unless the FINAL MP4 passes the perceptual/technical gate
// scripts/av_gate/zevanory_av_gate.py (V1–V8, fail-closed: FAIL/BLOCKED/ERROR_INFRA = no publish). One brand
// voice only (no Piper / no multi-model fallback): if the brand voice is unavailable the run is BLOCKED.
// Sales are CLOSED: no Short carries a price, a purchase link or a purchase promise.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getUsage, addUsage, allow } from "./usage.mjs";
import { createHash } from "node:crypto";
import { calendarEntry } from "../../worker/acquisition-engine.mjs";
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

// Commercial calendar (owner order, temporal certification): each slot has a planned Brasília
// time. A Short is NEVER published before its planned time, and never after its commercial day
// ends (late publication is allowed only inside the same day). Whatever scheduler fires the run
// (GitHub cron, the engine dispatcher, a manual dispatch) passes through this same rule.
export const SLOT_TIMES = Object.freeze({ dica: "10:00", oferta: "15:00", calc: "19:00" });
export const BRT_OFFSET = "-03:00"; // Brazil has had no daylight saving time since 2019.
export const LATE_TOLERANCE_MIN = 15;
export function publicationWindow({ day, slot, now = Date.now() }) {
  const time = SLOT_TIMES[slot];
  if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return { action: "reject", reason: "unknown_slot_or_day" };
  const plannedAt = Date.parse(`${day}T${time}:00${BRT_OFFSET}`);
  const dayEnd = Date.parse(`${day}T23:59:59${BRT_OFFSET}`);
  const base = { day, slot, plannedAt: new Date(plannedAt).toISOString() };
  if (now < plannedAt) return { ...base, action: "wait", reason: "before_planned_time", earlyMin: Math.round((plannedAt - now) / 60000) };
  if (now > dayEnd) return { ...base, action: "expired", reason: "commercial_day_over", delayMin: Math.round((now - plannedAt) / 60000) };
  const delayMin = Math.round((now - plannedAt) / 60000);
  return { ...base, action: "publish", late: delayMin > LATE_TOLERANCE_MIN, delayMin };
}
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
  const gate = VALUE_RISK.test(text) ? { action: "discard", score: 0, compliance: 0, reason: "value_risk_term" }
    : SALES_CLOSED_RISK.test(text) ? { action: "discard", score: 0, compliance: 0, reason: "sales_closed_purchase_cta" }
    : { action: "publish", score: 100, compliance: 100, reason: "value_gate_ok" };
  const entry = { theme_id: slot + ":" + item.slug, product: { name: screen.product, sku: null } };
  return { day, slot, entry, price: null, spec: null, gate, link: url, marker, title, description, lines: [], speech, said, screen, privacyStatus: "public", tags: ["ZEVANORY", "Shorts", "pequenos negócios", slot === "dica" ? item.name : item.name] };
}
export function planSlot(day, slot = "oferta") {
  if (!SLOTS.includes(slot)) throw new Error("short_slot_unknown");
  return slot === "oferta" ? planShort(day) : planValueShort(day, slot);
}

// Sales are CLOSED (owner order): the "oferta" slot no longer shows a price, a /comprar link or the purchase
// guarantee. It points to the free material for the niche. Re-opening needs a new reviewed change.
export const SALES_MODE = "closed";
const SALES_CLOSED_RISK = /\/comprar|R\$\s?\d|garantia de (7|sete) dias|\bcompre\b|checkout|\bpor apenas\b/i;
export function salesClosedViolations(plan) {
  const blob = [plan.speech, plan.title, plan.description, plan.link, ...Object.values(plan.screen || {})].join("\n");
  return SALES_CLOSED_RISK.test(blob) ? ["sales_closed_purchase_cta"] : [];
}
export function planShort(day) {
  const entry = calendarEntry(day);
  const niche = NICHE_LABEL[entry.niche];
  const campaign = "oferta_" + entry.product.sku.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const link = `https://vendas.zevanory.api.br/material-gratuito?utm_source=youtube&utm_medium=short&utm_campaign=${campaign}`;
  const marker = "zevanory-short-key:" + createHash("sha256").update(day + "|" + entry.theme_id + "|short-v3-sales-closed").digest("hex").slice(0, 16);
  const title = (ANGLE_HOOK[entry.angle] + " para " + niche + " · material gratuito").slice(0, 95);
  const description = [
    ANGLE_LINE[entry.angle] + " Material gratuito da ZEVANORY para " + niche + ", com revisão humana e sem promessas de faturamento.",
    "",
    "Material gratuito: " + link,
    "",
    "#Shorts #ZEVANORY #PequenosNegocios",
    "",
    marker
  ].join("\n");
  const lines = [ANGLE_HOOK[entry.angle], "Para " + niche, "", "Material gratuito"];
  const opener = /[?!.]$/.test(ANGLE_HOOK[entry.angle]) ? ANGLE_HOOK[entry.angle] : ANGLE_HOOK[entry.angle] + ".";
  const said = [[opener, "Isso é para " + niche + "."], [ANGLE_LINE[entry.angle]], ["No material gratuito da ZEVANORY tem o passo a passo."], ["O link está na descrição."]];
  const speech = said.map(b => b.join(" ")).join(" ");
  const screen = {
    hook: ANGLE_HOOK[entry.angle], niche: "para " + niche, tip: ANGLE_LINE[entry.angle],
    product: "Material gratuito", offer: "Passo a passo sem cadastro",
    cta: "Link na descrição", url: "vendas.zevanory.api.br"
  };
  const plan = { day, slot: "oferta", entry, price: null, spec: null, link, marker, title, description, lines, speech, said, screen, privacyStatus: "public", tags: ["ZEVANORY", "Shorts", "pequenos negócios", niche] };
  const text = [speech, title, description].join(" ");
  plan.gate = VALUE_RISK.test(text) || salesClosedViolations(plan).length
    ? { action: "discard", score: 0, compliance: 0, reason: "sales_closed_or_value_risk" }
    : { action: "publish", score: 100, compliance: 100, reason: "value_gate_ok_sales_closed" };
  return plan;
}

const run = (cmd, args) => { const p = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); if (p.status !== 0) throw new Error(cmd + "_failed"); return p.stdout; };

// ONE brand voice (P05 V4 identity): fixed model + fixed voice + short style passed ONLY as speech metadata
// (never concatenated into the transcript, which made the model read the instruction aloud). No Piper, no
// flash-lite/preview fallback: an unavailable brand voice BLOCKS the run (no publish).
export const BRAND_VOICE = Object.freeze({ provider: "gemini", model: "gemini-3.8-flash-tts", voice: "Achird", persona: "zevanory-brand", style: "tom amigável e confiante, ritmo de conversa, sotaque brasileiro" });
export async function brandVoice(text, key, { fetchImpl = fetch } = {}) {
  if (!key) return { blocked: "brand_voice_key_missing" };
  const body = { model: BRAND_VOICE.model, input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: BRAND_VOICE.style }] }] }], response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 }, generation_config: { speech_config: [{ voice: BRAND_VOICE.voice }] } };
  const r = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }).catch((e) => ({ ok: false, status: "fetch_" + (e?.name || "error") }));
  if (!r?.ok) return { blocked: "brand_voice_http_" + r?.status };  // provider status only, never the key
  const json = await r.json().catch(() => ({}));
  const part = (json.steps || []).filter((x) => x.type === "model_output").flatMap((x) => x.content || []).find((x) => x.type === "audio" && x.data);
  if (!part?.data) return { blocked: "brand_voice_no_audio" };
  const rate = Number(part.sample_rate || (String(part.mime_type || "").match(/rate=(\d+)/i) || [])[1]) || 24000;
  return { pcm: Buffer.from(part.data, "base64"), rate, model: BRAND_VOICE.model };
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
// zevanory-av-gate (P05): the narration goes through the production audio chain of the gate (master WAV −23 LUFS,
// streaming derivative with a true-peak limiter as the LAST stage and ONE AAC encode, captions aligned to the
// approved script), the video is muxed WITHOUT re-encoding the audio, and the FINAL MP4 must pass the gate.
export const CAPTION_STYLE = Object.freeze({ burned: true, font_color: "#F5F7FB", background_color: "#0C1C2B", box: [96, 1150, 768, 240], frame: [1080, 1920] });
export const BRAND_LEXICON = Object.freeze({ zevanory: ["zevanori", "zevanore", "ze vanori", "zé vanori", "zevan ori", "zeva nori"], whatsapp: ["whats app", "uatsap", "uótsap"] });
const AV_GATE = new URL("../av_gate/zevanory_av_gate.py", import.meta.url).pathname;
const PY = () => process.env.AV_GATE_PYTHON || "python3";
const sha256File = async (p) => createHash("sha256").update(await readFile(p)).digest("hex");

export function packageNarration(raw, scriptFile, dir) {
  const p = spawnSync(PY(), [AV_GATE, "package", "--raw", raw, "--script", scriptFile, "--out", dir, "--lexicon", JSON.stringify(BRAND_LEXICON)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  let out = null;
  try { out = JSON.parse(String(p.stdout || "").trim().split("\n").pop()); } catch {}
  if (p.status !== 0 || !out?.ok) throw new Error("av_gate_package_ERROR_INFRA");
  const cues = JSON.parse(readFileSync(dir + "/captions.json", "utf8"));
  return { master: out.master, narration: out.narration, captions: out.captions, cues, duration: out.duration_s };
}

// Fail-closed wrapper: anything other than an explicit PASS report with exit code 0 is a non-PASS verdict.
export function avGate(mp4, manifest, reportPath, { spawn = spawnSync } = {}) {
  const p = spawn(PY(), [AV_GATE, "check", "--mp4", mp4, "--manifest", manifest, "--out", reportPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  let rep = null;
  try { rep = JSON.parse(readFileSync(reportPath, "utf8")); } catch {}
  const verdict = ["PASS", "FAIL", "BLOCKED", "ERROR_INFRA"].includes(rep?.verdict) ? rep.verdict : "ERROR_INFRA";
  if (verdict === "PASS" && p?.status !== 0) return { verdict: "ERROR_INFRA", failed: [], blocked: [], errors: ["exit_code_mismatch"] };
  if (verdict !== "PASS" || p?.status !== 0) return { verdict: verdict === "PASS" ? "ERROR_INFRA" : verdict, failed: rep?.decision?.failed || [], blocked: rep?.decision?.blocked || [], errors: rep?.decision?.errors || ["gate_unavailable"] };
  return { verdict, failed: [], blocked: [], errors: [] };
}

export async function writeAvManifest(plan, dir, mp4, pkg, { reference = process.env.AV_GATE_BRAND_REFERENCE } = {}) {
  const man = {
    gate_version: "p05-av-gate-1", script: "script.txt", script_sha256: await sha256File(dir + "/script.txt"),
    master: "master.wav", master_sha256: await sha256File(dir + "/master.wav"),
    captions: "captions.vtt", captions_sha256: await sha256File(dir + "/captions.vtt"),
    mp4_sha256: await sha256File(mp4), voice: BRAND_VOICE, sales_mode: SALES_MODE,
    texts: { title: plan.title, description: plan.description, link: plan.link, screen: plan.screen },
    critical_terms: /zevanory/i.test(plan.speech) ? ["ZEVANORY"] : [], lexicon: BRAND_LEXICON, captions_style: CAPTION_STYLE,
  };
  // Owner-provided recording of the approved brand voice; without it the speaker check is BLOCKED (no publish).
  if (reference) man.brand_voice_reference = reference;
  await writeFile(dir + "/manifest.json", JSON.stringify(man, null, 1));
  return dir + "/manifest.json";
}

export async function renderVideo(plan, pkg, out) {
  const duration = Math.min(60, Math.max(8, Math.ceil(pkg.duration * 10) / 10));
  const XB = fontFile("ExtraBold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  const SB = fontFile("SemiBold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
  const R = /inter/i.test(XB) ? { xb: 0.58, sb: 0.54 } : { xb: 0.68, sb: 0.64 };
  const sc = plan.screen, draws = [];
  let n = 0;
  const text = async (str, font, size, color, baseline, enable = "") => {
    const file = `${out}.t${n++}.txt`;
    await writeFile(file, str);
    draws.push(`drawtext=fontfile=${font}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${baseline}-ascent${enable}`);
  };
  // Hook block (top, inside the safe area), visible from the first frame (feed preview).
  const hook = fitText(sc.hook, [120, 112, 104, 96, 88], 860, R.xb, 3);
  let y = 270;
  for (const line of hook.lines) { y += Math.round(hook.size * 1.08); await text(line, XB, hook.size, "0xf5f7fb", y); }
  const niche = fitText(sc.niche, [62, 56, 50], 860, R.sb, 2);
  y += 14;
  for (const line of niche.lines) { y += Math.round(niche.size * 1.3); await text(line, SB, niche.size, "0x8fb8ff", y); }
  // Burned captions = the words actually spoken (aligned to the voice), inside the caption card of CAPTION_STYLE.
  const [bx, by, bw, bh] = CAPTION_STYLE.box;
  for (const c of pkg.cues) {
    const f = fitText(c.text, [64, 58, 52, 46], bw - 64, R.sb, 2);
    const lh = Math.round(f.size * 1.25), top = by + Math.round((bh - f.lines.length * lh) / 2);
    for (let i = 0; i < f.lines.length; i++) await text(f.lines[i], SB, f.size, "0xf5f7fb", top + (i + 1) * lh - Math.round(f.size * 0.25), `:enable='between(t,${c.start},${c.end})'`);
  }
  const frames = Math.round(duration * 30);
  const vf = [
    "scale=1080:1920",
    "drawbox=x=56:y=600:w=968:h=560:color=0x0b0f16:t=fill",
    `zoompan=z='1+0.04*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`,
    "drawbox=x=96:y=228:w=220:h=8:color=0x00b8ff:t=fill",
    `drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=0x0c1c2b@1.0:t=fill`,
    `drawbox=x=${bx}:y=${by}:w=10:h=${bh}:color=0x00b8ff:t=fill`,
    ...draws
  ].join(",");
  const bar = `color=c=0x202a38:s=888x10:r=30:d=${duration}[track];color=c=0x00b8ff:s=888x10:r=30:d=${duration}[fill];[track][fill]overlay=x='-888+888*t/${duration}':y=0:shortest=1[bar];[base][bar]overlay=x=96:y=1724:shortest=1[v]`;
  // Audio is COPIED (no second lossy encode): the gate measures exactly what is uploaded.
  run("ffmpeg", ["-y", "-loop", "1", "-framerate", "30", "-i", "assets/brand/export/short.png", "-i", pkg.narration, "-filter_complex", "[0:v]" + vf + "[base];" + bar, "-map", "[v]", "-map", "1:a", "-t", String(duration), "-c:v", "libx264", "-r", "30", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out]);
  return { duration };
}

export async function renderShort(plan, base = "/tmp/zevanory-daily-short", { geminiKey = process.env.GEMINI_API_KEY, voice = brandVoice, pack = packageNarration, video = renderVideo, gate = avGate, manifest = writeAvManifest, onVoice = null } = {}) {
  const v = await voice(plan.speech, geminiKey);
  if (v?.pcm && onVoice) await onVoice(v);  // usage is counted even when the gate later rejects the take
  if (!v || v.blocked || !v.pcm || v.pcm.length < v.rate) throw new Error("brand_voice_BLOCKED:" + String(v?.blocked || "no_audio").replace(/[^a-z0-9_]/gi, "_"));
  const dir = base + ".av";
  await mkdir(dir, { recursive: true });
  await writeFile(dir + "/raw.pcm", v.pcm);
  await writeFile(dir + "/script.txt", plan.speech + "\n");
  run("ffmpeg", ["-y", "-f", "s16le", "-ar", String(v.rate), "-ac", "1", "-i", dir + "/raw.pcm", "-c:a", "pcm_s16le", dir + "/raw.wav"]);
  const pkg = await pack(dir + "/raw.wav", dir + "/script.txt", dir);
  const candidate = dir + "/final.mp4";
  const { duration } = await video(plan, pkg, candidate);
  const man = await manifest(plan, dir, candidate, pkg);
  const report = await gate(candidate, man, dir + "/av-gate.json");
  console.log("::notice title=AV_GATE::" + JSON.stringify({ slot: plan.slot, day: plan.day, verdict: report.verdict, failed: report.failed.slice(0, 10), blocked: report.blocked.slice(0, 6), errors: report.errors.slice(0, 6) }));
  if (report.verdict !== "PASS") throw new Error("av_gate_" + report.verdict + ":" + [...report.failed, ...report.blocked, ...report.errors].slice(0, 6).join("+"));
  // Only a PASSED file gets the name the uploader / cross-poster read, with a sealed PASS record.
  await copyFile(candidate, base + ".mp4");
  await writeFile(base + ".av-gate.json", JSON.stringify({ verdict: "PASS", mp4_sha256: await sha256File(base + ".mp4"), day: plan.day, slot: plan.slot }));
  return { file: base + ".mp4", duration, voice: v.model, gate: report };
}

// The cross-poster and the pack only accept a file sealed by a PASS of the gate for exactly these bytes.
export async function avGateSealed(mp4Path) {
  try {
    const seal = JSON.parse(await readFile(mp4Path.replace(/\.mp4$/, ".av-gate.json"), "utf8"));
    return seal.verdict === "PASS" && seal.mp4_sha256 === await sha256File(mp4Path);
  } catch { return false; }
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
  await kv.put("zpc:acquisition:daily:" + plan.day + ":youtube" + (plan.slot && plan.slot !== "oferta" ? "_" + plan.slot : ""), JSON.stringify({ channel: "youtube", slot: plan.slot || "oferta", day: plan.day, status: "publicado", provider_post_id: result.video_id, url: result.url, privacy: result.privacy_status, product: plan.entry.product.sku, at: new Date(now).toISOString(), planned_at: publicationWindow({ day: plan.day, slot: plan.slot || "oferta", now }).plannedAt || null, delay_min: publicationWindow({ day: plan.day, slot: plan.slot || "oferta", now }).delayMin ?? null }), { expirationTtl: 45 * 86400 });
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
      const window = publicationWindow({ day, slot, now: Date.now() });
      note("notice", "window " + JSON.stringify(window));
      if (window.action !== "publish" && !dry) { note("notice", slot + ": not published (" + window.reason + ") — " + (window.action === "wait" ? "the planned run publishes it" : "documented as missed for " + day)); continue; }
      const plan = planSlot(day, slot);
      if (plan.gate.action !== "publish" || plan.gate.compliance !== 100 || plan.gate.score < 85 || salesClosedViolations(plan).length) throw new Error("f1_gate_rejected");
      const base = "/tmp/zevanory-daily-short" + (slot === "oferta" ? "" : "-" + slot);
      const usageKv = process.env.CLOUDFLARE_API_TOKEN ? cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID }) : null;
      const usage = usageKv ? await getUsage(usageKv) : {};
      // Zero-cost guard: when the brand-voice budget is used up the run is BLOCKED (no other voice, no publish).
      if (!allow(usage, "gemini_tts_calls", 4)) throw new Error("brand_voice_BLOCKED:zero_cost_guard");
      // renderShort throws unless the FINAL MP4 passed zevanory-av-gate (fail-closed: no upload below).
      const rendered = await renderShort(plan, base, { geminiKey: process.env.GEMINI_API_KEY, onVoice: () => usageKv ? addUsage(usageKv, "gemini_tts_calls", 1).catch(() => null) : null });
      note("notice", JSON.stringify({ day, slot, theme: plan.entry.theme_id, gate: { score: plan.gate.score, compliance: plan.gate.compliance }, duration: rendered.duration, voice: rendered.voice, dry_run: dry }));
      if (dry) continue;
      for (const n of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID"]) if (!process.env[n]) throw new Error("missing_" + n);
      const { getYoutubeAccessToken } = await import("./youtube-access.mjs");
      const accessToken = await getYoutubeAccessToken();
      const kv = cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID });
      if (!allow(await getUsage(kv), "youtube_units", 1700)) throw new Error("zero_cost_guard_youtube_quota");
      if (!(await avGateSealed(rendered.file))) throw new Error("av_gate_seal_missing");
      const result = await publishShort(plan, await readFile(rendered.file), { accessToken });
      await addUsage(kv, "youtube_units", result.reused ? 5 : 1650).catch(() => null);
      const activity = await recordPublication(kv, plan, result);
      note("notice", JSON.stringify({ slot, ...result, activity_emitted: activity.emitted === true || activity.duplicate === true }));
    } catch (e) { failed++; note("error", slot + ":" + String(e?.message || e).replace(/[^a-z0-9_:.-]/gi, "_").slice(0, 140)); }
  }
  if (failed) process.exit(1);
}
