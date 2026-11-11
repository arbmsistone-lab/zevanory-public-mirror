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
import { CLOSED_LABEL, SHORT_RULE_LABEL, SHORT_RULE_SPOKEN } from "../../worker/politica-unica.mjs";
import { readSalesSwitch } from "../../worker/sales-control.mjs";
import { hotmartKitsOpen, hotmartKit } from "../../worker/sales-lock-content.mjs";
import { CREATIVE_AUTOPUBLISH_PAUSE_KEY } from "../../worker/creative-autonomy.mjs";
import { PRICE_BY_SKU } from "../../worker/product-prices.mjs";
import { textoProibido, violacoesShort, nivelRampa, decisaoSlot, avaliarPreflight, avaliarPosUpload, congelamentoAtivo, lerCongelamento, congelarEpisodio, idEpisodio, eQcFalha, gravarUmaVez, diasDaJanela, CHAVE_STATUS_DIA, CHAVE_QC_FALHA, CHAVE_CONGELADO, CHAVES_PUBLICADO } from "./shorts-retomada.mjs";

export const TARGET_CHANNEL = "UCMl8-SxMVv77S2tz2H63P3A";
// NC-1006-02: era uma tabela própria e velha (197/197/247/297/397) que o Short usaria com vendas abertas; agora é a
// tabela canônica data/products.json (worker/product-prices.mjs).
export const PRICES = PRICE_BY_SKU;
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
// Retomada controlada (Plano Mestre F1): rampa, voz e travas do canal em data/shorts-rampa.json.
export const RAMPA_CONFIG = Object.freeze(JSON.parse(readFileSync(new URL("../../data/shorts-rampa.json", import.meta.url), "utf8")));
// Calculadora gratuita do dia (CTA quando a compra pela Hotmart não está aberta).
export const calculatorFor = (day, offset = 0) => BANK.calculators[(((dayIndex(day) + offset) % BANK.calculators.length) + BANK.calculators.length) % BANK.calculators.length];
const shortUrl = (path, campaign) => `https://vendas.zevanory.api.br/${path}?utm_source=youtube&utm_medium=short&utm_campaign=${campaign}`;
const dayIndex = day => Math.floor(Date.parse(day + "T12:00:00Z") / 86400000);
const VALUE_RISK = /\b(gr[aá]tis|renda garantida|lucro garantido|ganhe dinheiro|resultado garantido|fature|enrique[cç]a|antes e depois|cura|milagre|voc[eê] sofre)\b/i;
const lowerFirst = t => t.charAt(0).toLowerCase() + t.slice(1);
export function planValueShort(day, slot, { salesOpen = false, hotmartOpen = false } = {}) {
  const i = dayIndex(day);
  // CTA da dica: o kit IA na Prática pela Hotmart (modo Hotmart) ou a calculadora gratuita do dia.
  const hotmart = salesOpen !== true && hotmartOpen === true ? hotmartKit("ia-na-pratica") : null;
  let item, use, url, screen, said, title, lead, campaign;
  if (slot === "dica") {
    item = BANK.guides[((i % BANK.guides.length) + BANK.guides.length) % BANK.guides.length];
    const k0 = Math.floor(i / BANK.guides.length) % item.uses.length;
    // Retomada: nenhum uso que cite WhatsApp (canal banido) ou lista de espera vai para roteiro, tela ou descrição.
    const safe = [...item.uses.slice(k0), ...item.uses.slice(0, k0)].filter(u => !VALUE_RISK.test(u) && textoProibido(u).length === 0);
    use = (safe[0] || "").replace(/[.\s]+$/, "");
    campaign = "dica_" + item.slug.replace(/^ia-para-/, "");
    title = "IA para " + lowerFirst(item.name) + ": 1 dica prática #shorts";
    const calc = calculatorFor(day);
    const cta = hotmart
      ? { path: "hotmart/" + hotmart.slug, product: hotmart.name, offer: "Kit com usos prontos", said: "No kit " + hotmart.name + " tem mais usos prontos para o seu negócio.", lead: "Mais usos prontos no kit " + hotmart.name + ", à venda pela Hotmart." }
      : { path: calc.slug, product: "Calculadora gratuita", offer: "Sem cadastro", said: "Faça também as contas do negócio na calculadora gratuita, sem cadastro.", lead: "Faça também as contas do seu negócio na " + lowerFirst(calc.name) + " gratuita da ZEVANORY, sem cadastro." };
    screen = { hook: "IA para " + lowerFirst(item.name), niche: "uma dica para aplicar hoje", tip: use + ".", product: cta.product, offer: cta.offer, cta: "Link na descrição", url: "vendas.zevanory.api.br" };
    said = [["IA para " + lowerFirst(item.name) + "?", "Uma dica prática."], [use + "."], [cta.said], ["O link está na descrição."]];
    lead = use + ". " + cta.lead;
    url = shortUrl(cta.path, campaign);
  } else {
    item = BANK.calculators[((i % BANK.calculators.length) + BANK.calculators.length) % BANK.calculators.length];
    campaign = "calc_" + item.slug.replace(/^calculadora-/, "");
    title = item.hook + " Calcule em segundos #shorts";
    screen = { hook: item.hook, niche: "calcule em segundos", tip: item.tip, product: item.name, offer: "Gratuita · sem cadastro", cta: "Link na descrição", url: "vendas.zevanory.api.br" };
    said = [[item.hook], [item.tip], ["Use a calculadora gratuita da ZEVANORY, sem cadastro."], ["O link está na descrição."]];
    lead = item.tip + " Faça a conta em segundos na calculadora gratuita da ZEVANORY, sem cadastro.";
  }
  if (slot !== "dica") url = shortUrl(item.slug, campaign);
  const marker = "zevanory-short-key:" + createHash("sha256").update(day + "|" + slot + "|" + item.slug + "|short-v2").digest("hex").slice(0, 16);
  const description = [lead, "", url, "", "#Shorts #ZEVANORY #PequenosNegocios #Empreendedorismo", "", marker].join("\n");
  const speech = said.map(b => b.join(" ")).join(" ");
  const text = [screen.hook, screen.tip, speech, description].join(" ");
  const gate = !use && slot === "dica" ? { action: "discard", score: 0, compliance: 0, reason: "sem_uso_seguro" } : VALUE_RISK.test(text) ? { action: "discard", score: 0, compliance: 0, reason: "value_risk_term" } : { action: "publish", score: 100, compliance: 100, reason: "value_gate_ok" };
  const entry = { short_context: {name:item.name,slug:item.slug}, theme_id: slot + ":" + item.slug, product: { name: screen.product, sku: slot === "dica" && hotmart ? hotmart.sku : null } };
  // purchase: "hotmart" quando a dica linka /hotmart/<slug> (as legendas do crosspost liberam o link de compra só nesse caso).
  return { day, slot, purchase: slot === "dica" && hotmart ? "hotmart" : "closed", entry, price: null, spec: null, gate, link: url, marker, title, description, lines: [], speech, said, screen, privacyStatus: "public", tags: ["ZEVANORY", "Shorts", "pequenos negócios", slot === "dica" ? item.name : item.name] };
}
export function planSlot(day, slot = "oferta", opts = {}) {
  if (!SLOTS.includes(slot)) throw new Error("short_slot_unknown");
  const plan = slot === "oferta" ? planShort(day, opts) : planValueShort(day, slot, opts);
  // Retomada (fail-closed): WhatsApp, lista de espera ou CTA fora de /hotmart/<slug> e da calculadora gratuita => descartado.
  const hotmartOpen = opts.salesOpen !== true && opts.hotmartOpen === true;
  const v = violacoesShort(plan, { hotmartOpen });
  return v.length ? { ...plan, gate: { action: "discard", score: 0, compliance: 0, reason: "retomada:" + v.join(",") }, violations: v } : plan;
}

// P13c: commercial lock = owner switch (KV sales:open:v1 + "LIBERAR VENDAS" + green preflight), read
// with the same worker/sales-control.mjs readSalesSwitch the Worker uses. Fail-closed.
export async function channelSalesOpen(kv) {
  if (!kv?.get) return false;
  return (await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }).catch(() => null))?.enabled === true;
}
// Modo Hotmart (sales:hotmart:v1, mesmo readHotmartSwitch do Worker): só vale com o interruptor completo fechado.
// Fail-closed: sem KV ou com erro de leitura => {salesOpen:false, hotmartOpen:false}.
export async function channelPurchaseMode(kv) {
  const salesOpen = await channelSalesOpen(kv);
  if (salesOpen || !kv?.get) return { salesOpen, hotmartOpen: false };
  return { salesOpen: false, hotmartOpen: await hotmartKitsOpen({ ZEVANORY_PRIVATE_ARTIFACTS: kv }) };
}
// Pausa da autopublicação criativa (painel /criativos, chave zpc:creative-autonomy:paused:v1, mesma regra do Worker:
// "1" = pausado). Estado desconhecido (sem KV, erro de leitura) = pausado: o Short não é publicado.
export async function channelPublishPaused(kv) {
  if (!kv?.get) return true;
  try { return String((await kv.get(CREATIVE_AUTOPUBLISH_PAUSE_KEY)) ?? "") === "1"; } catch { return true; }
}
const PRODUCT_PAGES = Object.freeze({ "ZEV-IA-011": "ia-na-pratica", "ZEV-VEN-011": "vendas-na-pratica", "ZEV-LCX-011": "lucro-e-caixa", "ZEV-CMB-011": "combo-ia-vendas", "ZEV-NGC-011": "negocio-completo" });

// Closed (default): the link goes to the product page (never /comprar/) and the text says sales are closed.
// Hotmart mode (full switch closed, Hotmart switch open): the 5 kits show their table price and the link goes to the
// Hotmart purchase path of the sales site (/hotmart/<slug>), never to the own checkout.
export function planShort(day, { salesOpen = false, hotmartOpen = false } = {}) {
  const entry = {...calendarEntry(day),short_variant:Math.floor((dayIndex(day)-dayIndex("2026-10-10"))/25)}, tablePrice = PRICES[entry.product.sku];
  if (!tablePrice) throw new Error("youtube_price_unknown");
  const kit = salesOpen !== true && hotmartOpen === true ? hotmartKit(entry.product.sku) : null;
  const price = kit ? kit.price : tablePrice;
  const niche = NICHE_LABEL[entry.niche];
  const hook = ANGLE_HOOK[entry.angle] + " para " + niche;
  const spec = { creative_id: "youtube-short-" + day, brand: "ZEVANORY", site: "zevanory.api.br", width: 1080, height: 1920, hook, body: entry.product.name + " por R$ " + price + ",00. " + SHORT_RULE_LABEL + ".", cta: "Veja o guia digital", price_brl: price };
  const gate = evaluateCreativeWithRewrites(spec, { serverPrice: price, visualScore: 1 });
  const ownCheckout = productLink(entry, "blog", { salesOpen: true }).replace("utm_source=blog", "utm_source=youtube");
  const productPage = new URL(ownCheckout); productPage.pathname = "/" + PRODUCT_PAGES[entry.product.sku];
  if (!PRODUCT_PAGES[entry.product.sku]) throw new Error("youtube_product_page_unknown");
  const hotmart = new URL(productPage.toString()); hotmart.pathname = "/hotmart/" + PRODUCT_PAGES[entry.product.sku];
  // Purchase link: own checkout with the full switch, the Hotmart purchase path in Hotmart mode.
  const checkout = kit ? hotmart.toString() : ownCheckout;
  const open = salesOpen === true || kit != null;
  // Retomada: com a compra fechada o CTA é a calculadora gratuita do dia (a página do produto pode ter lista de espera).
  const page = new URL(shortUrl(calculatorFor(day).slug, "oferta_" + PRODUCT_PAGES[entry.product.sku].replace(/-/g, "_")));
  const link = open ? checkout : page.toString();
  const marker = "zevanory-short-key:" + createHash("sha256").update(day + "|" + entry.theme_id + "|short-v1").digest("hex").slice(0, 16);
  const title = (ANGLE_HOOK[entry.angle] + " para " + niche + " · " + entry.product.name).slice(0, 95);
  const description = [
    ANGLE_LINE[entry.angle] + " Um guia prático da ZEVANORY para " + niche + ", com revisão humana e sem promessas de faturamento.",
    "",
    open ? entry.product.name + " — R$ " + price + ",00 · " + SHORT_RULE_LABEL + ": " + link : entry.product.name + " — " + CLOSED_LABEL + ". Enquanto isso, use a calculadora gratuita: " + link,
    "",
    "#Shorts #ZEVANORY #PequenosNegocios",
    "",
    marker
  ].join("\n");
  // Vendas fechadas (padrão): nada de preço nem de regra de compra na tela ou na voz; aviso CLOSED_LABEL.
  const closedLabel = CLOSED_LABEL.charAt(0).toUpperCase() + CLOSED_LABEL.slice(1);
  const lines = [ANGLE_HOOK[entry.angle], "Para " + niche, "", entry.product.name, open ? SHORT_RULE_LABEL : closedLabel];
  // Spoken script, grouped by on-screen beat: 1 hook, 2 practical tip, 3 offer, 4 call to action.
  const opener = /[?!.]$/.test(ANGLE_HOOK[entry.angle]) ? ANGLE_HOOK[entry.angle] : ANGLE_HOOK[entry.angle] + ".";
  const said = [[opener, "Isso é para " + niche + "."], [ANGLE_LINE[entry.angle]], [open ? entry.product.name + ", com " + SHORT_RULE_SPOKEN + "." : entry.product.name + ": " + CLOSED_LABEL + "."], ["Veja o guia no link da descrição."]];
  const speech = said.map(b => b.join(" ")).join(" ");
  const screen = {
    hook: ANGLE_HOOK[entry.angle], niche: "para " + niche, tip: ANGLE_LINE[entry.angle],
    product: entry.product.name, offer: open ? "R$ " + price + " · " + SHORT_RULE_LABEL : closedLabel,
    cta: "Link na descrição", url: "vendas.zevanory.api.br"
  };
  return { day, slot: "oferta", purchase: salesOpen === true ? "checkout" : kit ? "hotmart" : "closed", entry, price, spec, gate, link, marker, title, description, lines, speech, said, screen, privacyStatus: "public", tags: ["ZEVANORY", "Shorts", "pequenos negócios", entry.product.name] };
}

const run = (cmd, args) => { const p = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); if (p.status !== 0) throw new Error(cmd + "_failed"); return p.stdout; };

// Free, local, open-source neural voice (Piper, pt_BR). Zero cost; used when the Gemini free
// quota is exhausted or unavailable.
// Brand and money pronunciation for the local voice (Gemini already reads these correctly).
export function speechForLocalVoice(text) {
  return String(text)
    .replace(/ZEVANORY/gi, "Zevanóri")
    .replace(/R\$\s?(\d+)(?:,00)?/g, "$1 reais")
    .replace(/\bIA\b/g, "I.A.")
    .replace(/\bWhatsApp\b/gi, "uótsap")
    .replace(/\s+/g, " ").trim();
}
export function piperSpeech(text, model = process.env.PIPER_MODEL) {
  text = speechForLocalVoice(text);
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
// Objective audio quality gate: loudness, true peak and dead air inside the narration.
export function audioQuality(stderrEbur, silenceEnds, silenceStarts, voiceSeconds) {
  const lufs = Number((stderrEbur.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/-?[\d.]+/)?.[0]);
  const peak = Number((stderrEbur.match(/Peak:\s+(-?[\d.]+) dBFS/g) || []).pop()?.match(/-?[\d.]+/)?.[0]);
  let maxGap = 0;
  for (let i = 0; i < silenceStarts.length; i++) {
    const st = silenceStarts[i], en = silenceEnds[i] ?? voiceSeconds;
    if (st > 0.3 && st < voiceSeconds - 0.6) maxGap = Math.max(maxGap, Math.min(en, voiceSeconds) - st);
  }
  const reasons = [];
  if (!(lufs >= -20 && lufs <= -12)) reasons.push("loudness_" + lufs);
  if (!(peak <= -0.3)) reasons.push("peak_" + peak);
  if (maxGap > 1.6) reasons.push("dead_air_" + maxGap.toFixed(1));
  return { ok: reasons.length === 0, lufs, peak, maxGap: Math.round(maxGap * 10) / 10, reasons };
}
export async function renderShort(plan,base="/tmp/zevanory-daily-short",options={}){
  const {renderV2}=await import("../shorts-v2/render.mjs");
  return renderV2(plan,base,options);
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

const parseJson = (v) => { try { return v == null ? null : JSON.parse(String(v)); } catch { return null; } };
// Histórico da rampa a partir do KV (somente leitura): Shorts PÚBLICOS por dia e falhas de QC registradas.
// Erro de leitura => histórico vazio => nível 1 (falha para o volume menor, nunca para o maior).
export async function historicoRampa(kv, config, day) {
  const h = {};
  if (!kv?.get) return h;
  try {
    for (const d of diasDaJanela(config, day)) {
      let publicados = 0;
      for (const k of Object.values(CHAVES_PUBLICADO)) {
        const r = parseJson(await kv.get("zpc:acquisition:daily:" + d + ":" + k));
        if (r?.status === "publicado" && r?.privacy === "public") publicados++;
      }
      h[d] = { publicados, qc_falha: (await kv.get(CHAVE_QC_FALHA(d))) != null };
    }
    return h;
  } catch { return {}; }
}
// Slots já publicados hoje. Erro de leitura do KV PROPAGA (quem chama não publica): tratar como "não publicado"
// deixaria passar do limite diário da rampa.
export async function publicadosNoDia(kv, day, {warn=console.warn}={}) {
  const out = {};
  for (const [slot,k] of Object.entries(CHAVES_PUBLICADO)){
    const raw=await kv.get("zpc:acquisition:daily:"+day+":"+k);
    if(raw===null){out[slot]=false;continue;}
    const receipt=parseJson(raw);
    if(!receipt||typeof receipt!=="object"||!["publicado","pending","erro"].includes(receipt.status)){
      out[slot]=true; // presente mas ilegível: publicado desconhecido, nunca republicar
      warn("::warning title=SHORTS_RECEIPT::"+slot+" publicado_desconhecido: recibo ilegível");
      continue;
    }
    out[slot]=receipt.status==="publicado";
  }
  return out;
}
export async function preflightCanal({ accessToken, fetchImpl = fetch, avisoManual = false }) {
  let resp;
  try {
    const r = await fetchImpl("https://www.googleapis.com/youtube/v3/channels?part=id,status&mine=true", { headers: { authorization: "Bearer " + accessToken } });
    resp = { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
  } catch { resp = { ok: false, status: "fetch_error" }; }
  return avaliarPreflight(resp, { canalEsperado: TARGET_CHANNEL, avisoManual });
}
// Congela o canal registrando um EPISÓDIO (NC-F1-A5-01): grava um novo episódio se não houver um ativo; episódio
// liberado pelo proprietário é substituído; episódio ativo continua (não é sobrescrito).
export async function congelarCanal(kv, day, motivos, { now = Date.now(), config = RAMPA_CONFIG } = {}) {
  return congelarEpisodio(kv, { config, dia: day, motivos, now });
}

const note = (level, msg) => console.log(`::${level} title=YOUTUBE_DAILY_SHORT::${String(msg).replace(/[\r\n]+/g, " ")}`);
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const dry = process.argv.includes("--dry-run");
  const day = (process.argv.find(a => a.startsWith("--day=")) || "").slice(6) || localDay();
  const slotArg = (process.argv.find(a => a.startsWith("--slot=")) || "").slice(7) || "oferta";
  const slots = slotArg === "all" ? SLOTS : [slotArg];
  const cfg = RAMPA_CONFIG;
  let failed = 0;
  const lockKv = process.env.CLOUDFLARE_API_TOKEN ? cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID }) : null;
  const { salesOpen, hotmartOpen } = await channelPurchaseMode(lockKv);
  note("notice", "sales_open=" + salesOpen + " hotmart_open=" + hotmartOpen);
  // Creative-autonomy pause (or unknown state) => nothing is published; a dry run still renders for review.
  if (!dry && await channelPublishPaused(lockKv)) { note("notice", "creative_autopublish_paused_or_unknown: no Short published"); process.exit(0); }
  // Retomada controlada: nível da rampa (só leitura), congelamento persistido e preflight do canal ANTES de renderizar.
  const rampa = nivelRampa({ config: cfg, dia: day, historico: await historicoRampa(lockKv, cfg, day), avisoHoje: cfg.canal?.aviso_manual === true });
  // Erro de leitura do congelamento NUNCA vira "não congelado": sem a leitura, não publica (dry-run só relata).
  const cg = await lerCongelamento(lockKv);
  const congelado = !cg.erro && congelamentoAtivo({ config: cfg, registro: cg.registro });
  note("notice", "SHORTS_RAMPA " + JSON.stringify({ day, ...rampa, congelado, episodio_id: congelado ? idEpisodio(cg.registro) : null, congelamento_kv_erro: cg.erro, dry_run: dry }));
  if (!dry && cg.erro) { note("warning", "SHORTS_STATUS kv_indisponivel: congelamento ilegível, nenhum Short publicado em " + day); process.exit(0); }
  let accessToken = null, preflight = { estado: "nao_executado", motivos: [] };
  const credsOk = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID"].every(n => process.env[n]);
  if (!congelado && (credsOk || !dry)) {
    try {
      for (const n of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID"]) if (!process.env[n]) throw new Error("missing_" + n);
      const { getYoutubeAccessToken } = await import("./youtube-access.mjs");
      accessToken = await getYoutubeAccessToken();
      preflight = await preflightCanal({ accessToken, avisoManual: cfg.canal?.aviso_manual === true });
    } catch (e) { preflight = { estado: "indisponivel", motivos: [String(e?.message || e).replace(/[^a-z0-9_]/gi, "_").slice(0, 60)] }; }
  }
  note(preflight.estado === "restricao" ? "error" : "notice", "SHORTS_PREFLIGHT " + JSON.stringify(preflight));
  const estado = congelado ? "congelado" : preflight.estado === "restricao" ? "congelado" : preflight.estado === "indisponivel" ? "canal_indisponivel" : "ativo";
  if (!dry && lockKv) {
    if (!congelado && preflight.estado === "restricao") { const ep = await congelarCanal(lockKv, day, preflight.motivos).catch(() => null); note("error", "SHORTS_CONGELADO " + JSON.stringify(ep)); }
    // Registro do dia (1 gravação): guarda os slots do NÍVEL, nunca [] por causa do congelamento. Quem decide se o canal
    // está congelado é sempre a chave do episódio, lida de novo a cada execução; assim a liberação vale no mesmo dia.
    await gravarUmaVez(lockKv, CHAVE_STATUS_DIA(day), { day, nivel: rampa.nivel, por_dia: rampa.por_dia, slots: rampa.slots, dias_limpos: rampa.dias_limpos, estado, motivos: preflight.motivos, at: new Date().toISOString() }, { expirationTtl: 45 * 86400 }).catch(() => null);
  }
  if (!dry && estado !== "ativo") { note(estado === "congelado" ? "error" : "warning", "SHORTS_STATUS " + estado + ": nenhum Short publicado em " + day + " (" + preflight.motivos.join(",") + ")"); process.exit(0); }
  let jaHoje = {};
  if (!dry && lockKv) {
    try { jaHoje = await publicadosNoDia(lockKv, day); }
    catch { note("warning", "SHORTS_STATUS kv_indisponivel: contagem do dia ilegível, nenhum Short publicado em " + day); process.exit(0); }
  }
  for (const slot of slots) {
    try {
      const window = publicationWindow({ day, slot, now: Date.now() });
      note("notice", "window " + JSON.stringify(window));
      if (window.action !== "publish" && !dry) { note("notice", slot + ": not published (" + window.reason + ") — " + (window.action === "wait" ? "the planned run publishes it" : "documented as missed for " + day)); continue; }
      if (!dry && jaHoje[slot]) { note("notice", slot + ": ja_publicado_hoje"); continue; }
      const publicadosHoje = Object.entries(jaHoje).filter(([s, v]) => s !== slot && v).length;
      const dec = decisaoSlot({ rampa, slot, publicadosHoje, congelado: false });
      if (!dec.publicar && !dry) { note("notice", slot + ": " + dec.motivo + " (nivel " + rampa.nivel + ", " + rampa.por_dia + "/dia, slots " + rampa.slots.join("+") + ")"); continue; }
      const {planV2}=await import("../shorts-v2/core.mjs");
      const plan = planV2(planSlot(day, slot, { salesOpen, hotmartOpen }),{hotmartOpen});
      if (plan.gate.action !== "publish" || plan.gate.compliance !== 100 || plan.gate.score < 85) throw new Error("f1_gate_rejected:" + String(plan.gate.reason || "").replace(/[^a-z0-9_:,]/gi, "_"));
      const base = "/tmp/zevanory-daily-short" + (slot === "oferta" ? "" : "-" + slot);
      const usage = lockKv ? await getUsage(lockKv) : {};
      if(!allow(usage,"gemini_tts_calls",4))throw Error("zero_cost_guard_gemini_quota");
      // Reserve usage before synthesis, including failed attempts. No fallback voice.
      if(lockKv)await addUsage(lockKv,"gemini_tts_calls",1);
      const rendered = await renderShort(plan, base, {geminiKey:process.env.GEMINI_API_KEY,stateKv:lockKv,preview:dry});
      note("notice", JSON.stringify({ day, slot, theme: plan.entry.theme_id, gate: { score: plan.gate.score, compliance: plan.gate.compliance }, duration: rendered.duration, voice: rendered.voice, decisao: dec.motivo, dry_run: dry }));
      if(rendered.qc?.score!==100||rendered.qc?.ok!==true)throw Error("v2_qc_gate_failed");
      if (dry) continue;
      const kv = lockKv;
      if (!allow(await getUsage(kv), "youtube_units", 1700)) throw new Error("zero_cost_guard_youtube_quota");
      const result = await publishShort(plan, await readFile(rendered.file), { accessToken });
      await addUsage(kv, "youtube_units", result.reused ? 5 : 1650).catch(() => null);
      const activity = await recordPublication(kv, plan, result);
      jaHoje[slot] = true;
      note("notice", JSON.stringify({ slot, ...result, activity_emitted: activity.emitted === true || activity.duplicate === true }));
      const pos = avaliarPosUpload(result, plan.privacyStatus);
      if (pos.estado === "restricao") { const ep = await congelarCanal(kv, day, pos.motivos).catch(() => null); note("error", "SHORTS_STATUS congelado: " + pos.motivos.join(",") + " " + JSON.stringify(ep)); break; }
    } catch (e) {
      failed++;
      const msg = String(e?.message || e);
      if (!dry && lockKv && eQcFalha(msg)) await gravarUmaVez(lockKv, CHAVE_QC_FALHA(day), { day, slot, motivo: msg.slice(0, 120), at: new Date().toISOString() }, { expirationTtl: 45 * 86400 }).catch(() => null);
      note("error", slot + ":" + msg.replace(/[^a-z0-9_:.,-]/gi, "_").slice(0, 140));
    }
  }
  if (failed) process.exit(1);
}
