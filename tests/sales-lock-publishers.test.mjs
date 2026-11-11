// Trava de vendas nos publicadores de conteúdo, com o código real:
//  B) motor de aquisição (worker/acquisition-engine.mjs: runAcquisitionEngine -> publishChannel -> generateNative/validateDraft)
//     lendo a trava canônica KV sales:open:v1 por readSalesSwitch;
//  C) Short do YouTube (scripts/channels/youtube-daily-short.mjs planShort): tela, voz e descrição;
//  D') adaptadores de saída (worker/cloudflare-worker.recovered.mjs organicEventAllowed/ensureOutboundAllowed),
//     executados a partir do texto do próprio bundle.
// Estados: aberta (registro do dono "LIBERAR VENDAS" + preflight verde), fechada (sem registro), falha de leitura
// (KV lança exceção) e registro incompleto => sempre FECHADA.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { calendarEntry, generateNative, validateDraft, runAcquisitionEngine, productLink, verifyProductLink } from "../worker/acquisition-engine.mjs";
import { resetSalesSwitchCache, resetHotmartSwitchCache } from "../worker/sales-control.mjs";
import { CLOSED_LABEL } from "../worker/politica-unica.mjs";
import { salesLockViolations, payloadSalesLockViolations, contentSalesOpen, hotmartLockViolations, purchaseOpenFor, hotmartKitsOpen } from "../worker/sales-lock-content.mjs";
import { planShort, channelPublishPaused } from "../scripts/channels/youtube-daily-short.mjs";

const PNG = readFileSync(new URL("../assets/brand/export/post-01.png", import.meta.url));
const DAY = new Date("2026-10-10T23:00:00Z"); // depois do pico de Telegram (12h) e Bluesky (19h) em São Paulo
const SALES = "sales:open:v1", PREFLIGHT = "zpc-sales-preflight:v1", HOTMART = "sales:hotmart:v1", PAUSE = "zpc:creative-autonomy:paused:v1";

function kvWith(state) {
  const m = new Map();
  const nowIso = new Date(Date.now() - 60_000).toISOString();
  if (state === "open") {
    m.set(SALES, JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner-test", at: nowIso, ref: "teste/sales-lock" }));
    m.set(PREFLIGHT, JSON.stringify({ ok: true, at: nowIso }));
  }
  if (state === "incomplete") {
    m.set(SALES, JSON.stringify({ enabled: true, at: nowIso })); // sem "LIBERAR VENDAS"
    m.set(PREFLIGHT, JSON.stringify({ ok: true, at: nowIso }));
  }
  if (state === "stale_preflight") {
    m.set(SALES, JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner-test", at: nowIso, ref: "teste/sales-lock" }));
    m.set(PREFLIGHT, JSON.stringify({ ok: true, at: new Date(Date.now() - 4 * 3600_000).toISOString() }));
  }
  // Modo Hotmart (sales:hotmart:v1, registro do dono com channel "hotmart"); o interruptor completo segue fechado.
  const hotmartRecord = (extra = {}) => JSON.stringify({ enabled: true, channel: "hotmart", authorization: "LIBERAR VENDAS", by: "owner-test", at: nowIso, ref: "teste/hotmart-mode", ...extra });
  if (state === "hotmart" || state === "hotmart_paused" || state === "hotmart_throw") m.set(HOTMART, hotmartRecord());
  if (state === "hotmart_paused") m.set(PAUSE, "1");
  if (state === "hotmart_wrong_channel") m.set(HOTMART, hotmartRecord({ channel: "mercadopago" }));
  if (state === "hotmart_incomplete") m.set(HOTMART, hotmartRecord({ authorization: "" }));
  return {
    m,
    async get(k) { if (state === "throw" && k === SALES) throw new Error("kv_down"); if (state === "hotmart_throw" && k === HOTMART) throw new Error("kv_down"); return m.get(k) ?? null; },
    async put(k, v) { m.set(k, String(v)); },
  };
}

function network() {
  const sent = { telegram: [], bluesky: [] };
  const fetchImpl = async (url, req = {}) => {
    const u = String(url);
    if (req.method === "HEAD") return { status: 200 };
    if (u.endsWith("/brand/export/post-01.png")) return new Response(PNG, { status: 200 });
    if (u.includes("api.telegram.org")) { sent.telegram.push(JSON.parse(req.body)); return { status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }; }
    if (u.endsWith("createSession")) return { ok: true, json: async () => ({ did: "did:plc:abc", accessJwt: "access" }) };
    if (u.endsWith("createRecord")) { const r = JSON.parse(req.body); sent.bluesky.push(r); return { ok: true, json: async () => ({ uri: "at://did:plc:abc/app.bsky.feed.post/" + r.rkey, cid: "cid" }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { sent, fetchImpl };
}

async function runEngine(state) {
  resetSalesSwitchCache(); resetHotmartSwitchCache();
  const kv = kvWith(state);
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@zevanory", BLUESKY_HANDLE: "zevanory.bsky.social", BLUESKY_APP_PASSWORD: "app" };
  const net = network();
  const out = await runAcquisitionEngine(env, DAY, net.fetchImpl);
  resetSalesSwitchCache(); resetHotmartSwitchCache();
  const texts = [...net.sent.telegram.map((b) => String(b.caption || b.text || "")), ...net.sent.bluesky.map((r) => String(r.record?.text || ""))];
  return { out, texts, sent: net.sent, kv };
}

test("B: trava fechada, ilegível ou incompleta => Bluesky (Telegram desligado, F0 nº 7) sem preço, sem /comprar, sem CTA e com CLOSED_LABEL", async () => {
  for (const state of ["closed", "throw", "incomplete", "stale_preflight"]) {
    const { out, texts, sent } = await runEngine(state);
    assert.equal(out.outcomes.find((x) => x.channel === "bluesky")?.status, "publicado", state + ": bluesky publica a versão fechada");
    // Decisão F0 nº 7 (10/11/2026): Telegram de divulgação desligado no motor.
    assert.equal(out.outcomes.find((x) => x.channel === "telegram")?.status, "desligado", state);
    assert.equal(sent.telegram.length, 0, state); assert.equal(sent.bluesky.length, 1, state);
    for (const t of texts) {
      assert.deepEqual(salesLockViolations(t), [], state + ": " + t);
      assert.doesNotMatch(t, /\/comprar/, state);
      assert.ok(t.includes(CLOSED_LABEL), state + ": aviso de vendas fechadas: " + t);
      assert.match(t, /https:\/\/vendas\.zevanory\.api\.br\/ia-na-pratica\?utm_source=(telegram|bluesky)/, state + ": página do produto");
    }
    const bs = out.outcomes.find((x) => x.channel === "bluesky");
    assert.doesNotMatch(bs.utm, /\/comprar/, state);
    // Blog do mesmo ciclo: artigo salvo sem preço nem checkout (o link de compra é decidido na renderização).
    const blog = JSON.parse((await runEngine(state)).kv.m.get("zpc:blog:index:v1") || "{}").articles?.at(-1);
    if (blog) assert.deepEqual(salesLockViolations(blog.body + " " + blog.description), [], state + ": blog");
  }
});

test("B: trava aberta (dono + preflight verde) => link de checkout /comprar/<SKU>, comportamento atual preservado", async () => {
  const { out, texts, sent } = await runEngine("open");
  assert.equal(out.outcomes.find((x) => x.channel === "bluesky")?.status, "publicado");
  assert.equal(out.outcomes.find((x) => x.channel === "telegram")?.status, "desligado"); assert.equal(sent.telegram.length, 0);
  assert.equal(texts.length, 1);
  for (const t of texts) { assert.match(t, /https:\/\/vendas\.zevanory\.api\.br\/comprar\/ZEV-IA-011\?utm_source=/); assert.ok(!t.includes(CLOSED_LABEL)); }
});

test("B: validateDraft fechada rejeita R$, /comprar, Hotmart e chamada de compra; não exige /comprar; aberta exige", () => {
  const entry = calendarEntry("2026-10-10");
  for (const ch of ["telegram", "bluesky", "blog"]) {
    const closed = generateNative(entry, ch);
    assert.equal(validateDraft({ draft: closed, entry }).ok, true, ch + ": rascunho fechado válido sem /comprar");
    assert.equal(validateDraft({ draft: closed, entry, salesOpen: true }).ok, false, ch + ": aberta exige o checkout");
    const open = generateNative(entry, ch, { salesOpen: true });
    assert.equal(validateDraft({ draft: open, entry, salesOpen: true }).ok, true, ch + ": rascunho aberto válido");
    const r = validateDraft({ draft: open, entry }).reasons;
    assert.ok(r.includes("sales_closed_checkout_link"), ch + ": rascunho aberto barrado com vendas fechadas " + r);
    assert.ok(r.includes("sales_closed_label_missing"), ch);
  }
  const d = generateNative(entry, "telegram");
  const reasons = (text) => validateDraft({ draft: { ...d, text }, entry }).reasons;
  assert.ok(reasons(d.text + " Por R$ 197,00.").includes("sales_closed_price"));
  assert.ok(reasons(d.text + " https://pay.hotmart.com/X1").includes("sales_closed_checkout_link"));
  assert.ok(reasons(d.text + " https://vendas.zevanory.api.br/comprar/ZEV-IA-011").includes("sales_closed_checkout_link"));
  assert.ok(reasons(d.text + " Compre agora!").includes("sales_closed_purchase_cta"));
  assert.ok(reasons(d.text.replace(CLOSED_LABEL, "")).includes("sales_closed_label_missing"));
  // Aberta: preço permitido (regra atual).
  const o = generateNative(entry, "telegram", { salesOpen: true });
  assert.equal(validateDraft({ draft: { ...o, text: o.text + " Por R$ 197,00." }, entry, salesOpen: true }).ok, true);
  // Link fechado continua verificado contra o catálogo publicado.
  return verifyProductLink(productLink(entry, "telegram")).then((s) => assert.equal(s, 200));
});

test("B: leitura da trava é fail-closed (exceção, ausente, incompleta, preflight vencido)", async () => {
  for (const [state, want] of [["open", true], ["closed", false], ["throw", false], ["incomplete", false], ["stale_preflight", false]]) {
    resetSalesSwitchCache();
    assert.equal(await contentSalesOpen({ ZEVANORY_PRIVATE_ARTIFACTS: kvWith(state) }), want, state);
  }
  resetSalesSwitchCache();
  assert.equal(await contentSalesOpen({}), false);
  assert.equal(await contentSalesOpen(null), false);
  resetSalesSwitchCache();
});

test("C: Short fechado => sem preço na tela nem na voz; CLOSED_LABEL na tela, na voz e na descrição; aberto mantém o preço", () => {
  for (let d = 0; d < 35; d++) {
    const day = new Date(Date.UTC(2026, 9, 11 + d)).toISOString().slice(0, 10);
    const p = planShort(day);
    const onScreen = Object.values(p.screen).join(" | ") + " | " + p.lines.join(" | ");
    assert.doesNotMatch(onScreen, /R\$/, day + ": preço na tela");
    assert.doesNotMatch(p.speech, /R\$|reais|\d{3}/, day + ": preço na voz");
    assert.match(p.screen.offer, new RegExp(CLOSED_LABEL, "i"), day);
    assert.match(p.lines.at(-1), new RegExp(CLOSED_LABEL, "i"), day + ": roteiro de tela fechado");
    assert.doesNotMatch(onScreen + " " + p.speech, /arrependimento/i, day + ": regra de compra só com vendas abertas");
    assert.ok(p.speech.includes(CLOSED_LABEL), day);
    assert.ok(p.description.includes(CLOSED_LABEL), day);
    assert.deepEqual(salesLockViolations(onScreen + " " + p.speech + " " + p.description), [], day);
    const o = planShort(day, { salesOpen: true });
    assert.match(o.screen.offer, /^R\$ \d+ · /, day + ": aberto mostra o preço");
    assert.match(o.link, /\/comprar\//, day);
  }
});

// Bloco contíguo do bundle: ORGANIC_DESTINATIONS ... ensureOutboundAllowed (texto real, sem cópia).
const BUNDLE = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
function outboundBox() {
  const start = BUNDLE.indexOf("var ORGANIC_DESTINATIONS = ");
  const endMark = '}, "ensureOutboundAllowed");';
  const end = BUNDLE.indexOf(endMark, start);
  assert.ok(start > 0 && end > start, "bloco dos adaptadores encontrado");
  const box = vm.createContext({ __name: (f) => f, salesGate: () => ({ enabled: false }), assertBrandSafeCreative: () => {}, payloadSalesLockViolations });
  vm.runInContext(BUNDLE.slice(start, end + endMark.length) + "\nthis.ensureOutboundAllowed = ensureOutboundAllowed; this.organicEventAllowed = organicEventAllowed;", box);
  return box;
}

test("D': adaptador orgânico com vendas fechadas recusa texto com preço, checkout ou CTA (não só landing_url)", () => {
  const box = outboundBox();
  const env = { ORGANIC_PUBLISHING_ENABLED: "true" };
  const closed = () => ({ enabled: false }), open = () => ({ enabled: true });
  const ev = (payload) => ({ event_type: "publish_content", destination: "channel:linkedin", payload: { organic_only: true, content: "Uma dica prática para organizar a semana.", title: "Dica", ...payload } });
  assert.doesNotThrow(() => box.ensureOutboundAllowed(ev({}), env, closed), "texto orgânico limpo segue");
  assert.equal(box.organicEventAllowed(ev({}), env, closed), true);
  for (const [name, p] of [
    ["preço no conteúdo", { content: "Guia por R$ 197,00." }],
    ["/comprar na descrição", { description: "https://vendas.zevanory.api.br/comprar/ZEV-IA-011" }],
    ["Hotmart no título", { title: "https://pay.hotmart.com/X1" }],
    ["CTA de compra", { content: "Compre agora o guia." }],
    ["preço estruturado", { price_brl: 197 }],
    ["legenda com preço", { caption: "R$ 97 hoje" }],
    ["/comprar sem barra no link", { link: "https://vendas.zevanory.api.br/comprar?sku=ZEV-IA-011" }],
  ]) {
    assert.equal(box.organicEventAllowed(ev(p), env, closed), false, name);
    assert.throws(() => box.ensureOutboundAllowed(ev(p), env, closed), /commercial_gates_closed/, name);
  }
  // Vendas abertas: o portão comercial libera (comportamento atual).
  assert.doesNotThrow(() => box.ensureOutboundAllowed(ev({ content: "Guia por R$ 197,00." }), env, open));
  assert.deepEqual(payloadSalesLockViolations({ content: "ok", price_brl: 0 }), ["price"]);
  assert.deepEqual(payloadSalesLockViolations(null), []);
});

test("D7: Instagram e Facebook fechados sem P04 certificado, com vendas abertas ou fechadas e texto limpo", () => {
  const box = outboundBox();
  const env = { ORGANIC_PUBLISHING_ENABLED: "true" };
  const closed = () => ({ enabled: false }), open = () => ({ enabled: true });
  for (const destination of ["channel:instagram", "channel:facebook"]) {
    const ev = { event_type: "publish_content", destination, payload: { organic_only: true, content: "Uma dica prática para organizar a semana.", title: "Dica" } };
    assert.equal(box.organicEventAllowed(ev, env, closed), false, destination + ": orgânico limpo não é liberado");
    assert.throws(() => box.ensureOutboundAllowed(ev, env, closed), /p04_meta_closed/, destination + ": vendas fechadas");
    assert.throws(() => box.ensureOutboundAllowed(ev, env, open), /p04_meta_closed/, destination + ": vendas abertas não reabrem a Meta");
    const promo = { event_type: "publish_content", destination, payload: { content: "Guia por R$ 197,00." } };
    assert.throws(() => box.ensureOutboundAllowed(promo, env, open), /p04_meta_closed/, destination + ": comercial com vendas abertas");
    const dm = { event_type: "send_message", destination, payload: { content: "Oi, tudo bem?" } };
    assert.throws(() => box.ensureOutboundAllowed(dm, env, open), /p04_meta_closed/, destination + ": mensagem não-suporte também fechada");
    const support = { event_type: "send_support_message", destination, payload: { support_only: true, content: "Seu acesso foi reenviado." } };
    assert.throws(() => box.ensureOutboundAllowed(support, env, closed), /p04_meta_closed/, destination + ": suporte automático também fechado (R16)");
    assert.throws(() => box.ensureOutboundAllowed(support, env, open), /p04_meta_closed/, destination + ": suporte com vendas abertas também fechado");
  }
  const other = { event_type: "publish_content", destination: "channel:linkedin", payload: { organic_only: true, content: "Uma dica prática para organizar a semana.", title: "Dica" } };
  assert.doesNotThrow(() => box.ensureOutboundAllowed(other, env, closed), "canal não Meta segue a regra comercial normal");
});

test("H: modo Hotmart (interruptor completo fechado + sales:hotmart:v1) => 5 kits com preço e /hotmart/<slug>; falha = fechado; pausa vale", async () => {
  // Engine (Bluesky; Telegram desligado pela decisão F0 nº 7): kit do dia (IA na Prática, R$ 97) com o caminho de compra pela Hotmart.
  const { out, texts, sent } = await runEngine("hotmart");
  assert.equal(out.outcomes.find((x) => x.channel === "bluesky")?.status, "publicado", "hotmart: bluesky");
  assert.equal(out.outcomes.find((x) => x.channel === "telegram")?.status, "desligado", "hotmart: telegram desligado");
  assert.equal(sent.telegram.length, 0); assert.equal(sent.bluesky.length, 1); assert.equal(texts.length, 1);
  for (const t of texts) {
    assert.match(t, /https:\/\/vendas\.zevanory\.api\.br\/hotmart\/ia-na-pratica\?utm_source=(telegram|bluesky)/, "hotmart: caminho de compra do kit: " + t);
    assert.ok(t.includes("R$ 97"), "hotmart: preço da tabela: " + t);
    assert.doesNotMatch(t, /\/comprar/, "hotmart: nunca o checkout próprio");
    assert.ok(!t.includes(CLOSED_LABEL), "hotmart: sem aviso de fechado");
    assert.deepEqual(hotmartLockViolations(t, "ZEV-IA-011"), [], "hotmart: só preço e link do kit: " + t);
  }
  // O interruptor completo continua fechado; Conteúdo Pronto nunca abre pelo modo Hotmart.
  resetSalesSwitchCache(); resetHotmartSwitchCache();
  const hm = { ZEVANORY_PRIVATE_ARTIFACTS: kvWith("hotmart") };
  assert.equal(await contentSalesOpen(hm), false, "interruptor completo fechado");
  assert.equal(await hotmartKitsOpen(hm), true);
  assert.equal(await purchaseOpenFor(hm, "ZEV-IA-011"), true); assert.equal(await purchaseOpenFor(hm, "negocio-completo"), true);
  assert.equal(await purchaseOpenFor(hm, "conteudo-pronto"), false, "assinatura fechada no modo Hotmart");
  assert.equal(await purchaseOpenFor(hm, "ZEV-XYZ-999"), false);
  // Fail-closed: canal errado, registro incompleto, exceção na leitura => versão fechada (página + aviso).
  for (const state of ["hotmart_wrong_channel", "hotmart_incomplete", "hotmart_throw"]) {
    resetSalesSwitchCache(); resetHotmartSwitchCache();
    assert.equal(await hotmartKitsOpen({ ZEVANORY_PRIVATE_ARTIFACTS: kvWith(state) }), false, state);
    assert.equal(await purchaseOpenFor({ ZEVANORY_PRIVATE_ARTIFACTS: kvWith(state) }, "ZEV-IA-011"), false, state);
    const r = await runEngine(state);
    for (const t of r.texts) { assert.ok(t.includes(CLOSED_LABEL), state + ": " + t); assert.deepEqual(salesLockViolations(t), [], state); }
  }
  // A pausa da autopublicação criativa continua valendo no modo Hotmart.
  const paused = await runEngine("hotmart_paused");
  assert.equal(paused.out.outcomes.find((x) => x.channel === "bluesky")?.status, "pausado", "pausa: bluesky");
  assert.equal(paused.out.outcomes.find((x) => x.channel === "telegram")?.status, "desligado", "pausa: telegram segue desligado");
  assert.equal(paused.sent.telegram.length + paused.sent.bluesky.length, 0, "pausa: nada publicado");
  // validateDraft no modo Hotmart: só o preço e o caminho DESTE kit; preço obrigatório; nada mais.
  const entry = calendarEntry("2026-10-10");
  for (const ch of ["telegram", "bluesky", "blog"]) {
    const d = generateNative(entry, ch, { hotmartOpen: true });
    assert.equal(validateDraft({ draft: d, entry, hotmartOpen: true }).ok, true, ch + ": rascunho Hotmart válido");
    assert.equal(validateDraft({ draft: d, entry }).ok, false, ch + ": rascunho Hotmart barrado com tudo fechado");
  }
  const d = generateNative(entry, "telegram", { hotmartOpen: true });
  const reasons = (text) => validateDraft({ draft: { ...d, text }, entry, hotmartOpen: true }).reasons;
  assert.ok(reasons(d.text + " Por R$ 197,00.").includes("hotmart_price"), "outro preço");
  assert.ok(reasons(d.text + " https://pay.hotmart.com/X1").includes("hotmart_checkout_link"), "checkout externo");
  assert.ok(reasons(d.text + " https://vendas.zevanory.api.br/hotmart/lucro-e-caixa").includes("hotmart_checkout_link"), "outro kit");
  assert.ok(reasons(d.text + " https://vendas.zevanory.api.br/comprar/ZEV-IA-011").includes("hotmart_checkout_link"), "checkout próprio");
  assert.ok(reasons(d.text + " Compre agora!").includes("hotmart_purchase_cta"), "chamada de compra");
  assert.ok(reasons(d.text.replace("R$ 97", "")).includes("hotmart_price_missing"), "preço obrigatório");
  assert.equal(await verifyProductLink(productLink(entry, "telegram", { hotmartOpen: true })), 200);
  // Short do YouTube: preço do kit (97) e /hotmart/<slug>; sem o modo, fechado como antes.
  const p = planShort("2026-10-10", { hotmartOpen: true });
  assert.equal(p.purchase, "hotmart"); assert.equal(p.price, 97);
  assert.match(p.link, /^https:\/\/vendas\.zevanory\.api\.br\/hotmart\/ia-na-pratica\?utm_source=youtube/);
  assert.match(p.screen.offer, /^R\$ 97 · /);
  assert.deepEqual(hotmartLockViolations(Object.values(p.screen).join(" ") + " " + p.description, "ZEV-IA-011"), []);
  assert.equal(planShort("2026-10-10").purchase, "closed");
  assert.equal(planShort("2026-10-10", { salesOpen: true, hotmartOpen: true }).purchase, "checkout", "interruptor completo prevalece");
  // Pausa no job do Short: "1" = pausado; sem KV ou erro de leitura = pausado (não publica).
  const pk = (v, fail = false) => ({ async get(k) { if (fail) throw new Error("kv_down"); return k === PAUSE ? v : null; } });
  assert.equal(await channelPublishPaused(pk("1")), true);
  assert.equal(await channelPublishPaused(pk("0")), false);
  assert.equal(await channelPublishPaused(pk(null)), false);
  assert.equal(await channelPublishPaused(null), true, "sem KV = desconhecido = pausado");
  assert.equal(await channelPublishPaused(pk("0", true)), true, "erro de leitura = pausado");
  resetSalesSwitchCache(); resetHotmartSwitchCache();
});

// KV falso do Cloudflare (API REST) carregado antes do script: só GET de valores; pausa = "1". Qualquer outra chamada
// de rede é registrada e reprova o teste (nada de YouTube, Gemini, TikTok, Meta ou Telegram).
const PAUSED_KV = "data:text/javascript," + encodeURIComponent(`
const calls = [];
globalThis.fetch = async (u, o = {}) => {
  u = String(u); calls.push((o.method || "GET") + " " + u.replace(/^https:\\/\\/[^/]+/, ""));
  process.on("exit", () => console.log("FETCH_CALLS=" + JSON.stringify(calls)));
  const m = u.match(/^https:\\/\\/api\\.cloudflare\\.com\\/client\\/v4\\/accounts\\/acc\\/storage\\/kv\\/namespaces\\/ns\\/values\\/([^?]+)$/);
  if (!m || (o.method || "GET") !== "GET") return new Response("blocked", { status: 599 });
  const k = decodeURIComponent(m[1]);
  return k === "zpc:creative-autonomy:paused:v1" ? new Response("1", { status: 200 }) : new Response("", { status: 404 });
};`);
test("P: pausa criativa = \"1\" com o KV lendo normalmente => Short e cross-post não publicam", () => {
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc", KV_NAMESPACE_ID: "ns", YOUTUBE_CLIENT_ID: "", GEMINI_API_KEY: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@c" };
  const run = (script) => spawnSync(process.execPath, ["--import", PAUSED_KV, script, "--slot=oferta", "--day=2026-11-08"], { cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 60000 });
  const yt = run("scripts/channels/youtube-daily-short.mjs");
  assert.equal(yt.status, 0, yt.stdout + yt.stderr);
  assert.match(yt.stdout, /sales_open=false hotmart_open=false/, "KV lido (interruptores ausentes = fechados)");
  assert.match(yt.stdout, /creative_autopublish_paused_or_unknown: no Short published/);
  assert.doesNotMatch(yt.stdout, /window /, "parou antes de planejar/renderizar/publicar");
  const ytCalls = JSON.parse((yt.stdout.match(/FETCH_CALLS=(.*)/) || [])[1] || "[]");
  assert.ok(ytCalls.length > 0 && ytCalls.every((c) => c.startsWith("GET /client/v4/accounts/acc/storage/kv/")), "só leituras do KV: " + ytCalls);
  assert.ok(ytCalls.some((c) => c.includes("zpc%3Acreative-autonomy%3Apaused%3Av1")), "a chave da pausa foi lida");
  const cross = run("scripts/channels/short-crosspost.mjs");
  assert.equal(cross.status, 0, cross.stdout + cross.stderr);
  assert.match(cross.stdout, /SHORT_CROSSPOST::creative_autopublish_paused_or_unknown/);
  const crossCalls = JSON.parse((cross.stdout.match(/FETCH_CALLS=(.*)/) || [])[1] || "[]");
  assert.deepEqual(crossCalls, ["GET /client/v4/accounts/acc/storage/kv/namespaces/ns/values/zpc%3Acreative-autonomy%3Apaused%3Av1"], "cross-post: só a leitura da pausa, nenhum envio");
});
