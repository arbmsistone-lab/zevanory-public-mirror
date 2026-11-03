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
import { readFileSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { calendarEntry, generateNative, validateDraft, runAcquisitionEngine, productLink, verifyProductLink } from "../worker/acquisition-engine.mjs";
import { resetSalesSwitchCache } from "../worker/sales-control.mjs";
import { CLOSED_LABEL } from "../worker/politica-unica.mjs";
import { salesLockViolations, payloadSalesLockViolations, contentSalesOpen } from "../worker/sales-lock-content.mjs";
import { planShort } from "../scripts/channels/youtube-daily-short.mjs";

const PNG = readFileSync(new URL("../assets/brand/export/post-01.png", import.meta.url));
const DAY = new Date("2026-10-10T23:00:00Z"); // depois do pico de Telegram (12h) e Bluesky (19h) em São Paulo
const SALES = "sales:open:v1", PREFLIGHT = "zpc-sales-preflight:v1";

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
  return {
    m,
    async get(k) { if (state === "throw" && k === SALES) throw new Error("kv_down"); return m.get(k) ?? null; },
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
  resetSalesSwitchCache();
  const kv = kvWith(state);
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@zevanory", BLUESKY_HANDLE: "zevanory.bsky.social", BLUESKY_APP_PASSWORD: "app" };
  const net = network();
  const out = await runAcquisitionEngine(env, DAY, net.fetchImpl);
  resetSalesSwitchCache();
  const texts = [...net.sent.telegram.map((b) => String(b.caption || b.text || "")), ...net.sent.bluesky.map((r) => String(r.record?.text || ""))];
  return { out, texts, sent: net.sent, kv };
}

test("B: trava fechada, ilegível ou incompleta => Telegram e Bluesky sem preço, sem /comprar, sem CTA e com CLOSED_LABEL", async () => {
  for (const state of ["closed", "throw", "incomplete", "stale_preflight"]) {
    const { out, texts, sent } = await runEngine(state);
    for (const ch of ["telegram", "bluesky"]) assert.equal(out.outcomes.find((x) => x.channel === ch)?.status, "publicado", state + ": " + ch + " publica a versão fechada");
    assert.equal(sent.telegram.length, 1, state); assert.equal(sent.bluesky.length, 1, state);
    for (const t of texts) {
      assert.deepEqual(salesLockViolations(t), [], state + ": " + t);
      assert.doesNotMatch(t, /\/comprar/, state);
      assert.ok(t.includes(CLOSED_LABEL), state + ": aviso de vendas fechadas: " + t);
      assert.match(t, /https:\/\/vendas\.zevanory\.api\.br\/ia-na-pratica\?utm_source=(telegram|bluesky)/, state + ": página do produto");
    }
    const tg = out.outcomes.find((x) => x.channel === "telegram");
    assert.doesNotMatch(tg.utm, /\/comprar/, state);
    // Blog do mesmo ciclo: artigo salvo sem preço nem checkout (o link de compra é decidido na renderização).
    const blog = JSON.parse((await runEngine(state)).kv.m.get("zpc:blog:index:v1") || "{}").articles?.at(-1);
    if (blog) assert.deepEqual(salesLockViolations(blog.body + " " + blog.description), [], state + ": blog");
  }
});

test("B: trava aberta (dono + preflight verde) => link de checkout /comprar/<SKU>, comportamento atual preservado", async () => {
  const { out, texts } = await runEngine("open");
  for (const ch of ["telegram", "bluesky"]) assert.equal(out.outcomes.find((x) => x.channel === ch)?.status, "publicado", ch);
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
    assert.doesNotThrow(() => box.ensureOutboundAllowed(support, env, closed), destination + ": suporte sem intenção comercial segue (A-07 pendente)");
  }
  const other = { event_type: "publish_content", destination: "channel:linkedin", payload: { organic_only: true, content: "Uma dica prática para organizar a semana.", title: "Dica" } };
  assert.doesNotThrow(() => box.ensureOutboundAllowed(other, env, closed), "canal não Meta segue a regra comercial normal");
});
