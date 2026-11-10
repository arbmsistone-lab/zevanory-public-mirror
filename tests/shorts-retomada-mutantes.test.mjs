// Mutantes da retomada controlada dos Shorts. Cada mutante troca UM trecho exato do código (que precisa existir uma
// única vez) e importa a cópia mutada; a bateria de asserções precisa reprová-lo. Um mutante só conta como morto se
// a mesma bateria passa na cópia original (linha de base). Nada é gravado fora do diretório temporário: o
// youtube-daily-short.mjs mutado roda numa árvore espelho (scripts/channels copiado; worker/ e data/ por link).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, copyFileSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = {
  retomada: join(ROOT, "scripts/channels/shorts-retomada.mjs"),
  dispatcher: join(ROOT, "scripts/ops/engine-dispatcher.mjs"),
  short: join(ROOT, "scripts/channels/youtube-daily-short.mjs"),
  crosspost: join(ROOT, "scripts/channels/short-crosspost.mjs"),
};
const CFG = JSON.parse(readTextNormalized(join(ROOT, "data/shorts-rampa.json")));
const TMP = mkdtempSync(join(tmpdir(), "zevanory-shorts-mut-"));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
// Árvore espelho para os imports relativos do Short: ../../worker, ../../data e ../../assets apontam para o repositório.
const MIRROR = join(TMP, "mirror"), MIRROR_CH = join(MIRROR, "scripts/channels");
mkdirSync(MIRROR_CH, { recursive: true });
for (const d of ["worker", "data", "assets"]) symlinkSync(join(ROOT, d), join(MIRROR, d), process.platform === "win32" ? "junction" : "dir");
for (const f of readdirSync(join(ROOT, "scripts/channels"))) if (f.endsWith(".mjs")) copyFileSync(join(ROOT, "scripts/channels", f), join(MIRROR_CH, f));

let seq = 0;
async function load(kind, find, replace) {
  const src = readTextNormalized(SRC[kind]);
  let out = src;
  if (find != null) {
    assert.equal(src.split(find).length - 1, 1, `trecho do mutante deve existir uma única vez em ${kind}: ${find.slice(0, 80)}`);
    out = src.replace(find, () => replace);
  }
  seq += 1;
  const file = kind === "short" || kind === "crosspost" ? join(MIRROR_CH, `mutante-${seq}-${kind}.mjs`) : join(TMP, `${kind}-${seq}.mjs`);
  writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const somar = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const days = (n, s = "2026-11-10") => Array.from({ length: n }, (_, i) => somar(s, i));
const hist = (l) => Object.fromEntries(l.map(([d, publicados, x = {}]) => [d, { publicados, ...x }]));
const chan = (status) => ({ ok: true, status: 200, json: { items: [{ id: "UCMl8-SxMVv77S2tz2H63P3A", status } ] } });

// Bateria do módulo puro (texto, CTA, rampa, preflight, congelamento, gravação única).
async function bateriaRetomada(m) {
  for (const t of ["Responder no WhatsApp", "chama no zap", "https://wa.me/55"]) assert.ok(m.textoProibido(t).includes("whatsapp"), t);
  assert.ok(m.textoProibido("Entre na lista de espera").includes("lista_de_espera"));
  const ok = "https://vendas.zevanory.api.br/calculadora-cmv?utm_source=youtube&utm_medium=short&utm_campaign=c";
  assert.equal(m.ctaPermitido(ok).ok, true);
  assert.equal(m.ctaPermitido("https://vendas.zevanory.api.br/ia-para-padaria?utm_source=youtube&utm_medium=short&utm_campaign=c").ok, false);
  assert.equal(m.ctaPermitido("https://vendas.zevanory.api.br/comprar/X?utm_source=youtube&utm_medium=short&utm_campaign=c").ok, false);
  assert.equal(m.ctaPermitido("https://vendas.zevanory.api.br/hotmart/ia-na-pratica?utm_source=youtube&utm_medium=short&utm_campaign=c").ok, false);
  assert.equal(m.ctaPermitido("https://vendas.zevanory.api.br/hotmart/ia-na-pratica?utm_source=youtube&utm_medium=short&utm_campaign=c", { hotmartOpen: true }).ok, true);
  assert.equal(m.ctaPermitido("https://vendas.zevanory.api.br/calculadora-cmv?utm_medium=short&utm_campaign=c").ok, false);
  const plano = { title: "t", description: "d " + ok, speech: "s", said: [["s"]], screen: { cta: "Link" }, tags: ["x"], link: ok };
  assert.deepEqual(m.violacoesShort(plano), []);
  assert.ok(m.violacoesShort({ ...plano, speech: "Responder no WhatsApp" }).includes("whatsapp"));
  const d = days(16);
  assert.equal(m.nivelRampa({ config: CFG, dia: d[7], historico: hist(d.slice(0, 6).map((x) => [x, 1])) }).nivel, 1);
  assert.equal(m.nivelRampa({ config: CFG, dia: d[7], historico: hist(d.slice(0, 7).map((x) => [x, 1])) }).nivel, 2);
  assert.equal(m.nivelRampa({ config: CFG, dia: d[7], historico: hist(d.slice(0, 7).map((x) => [x, 0])) }).nivel, 1);
  const base = [...d.slice(0, 7).map((x) => [x, 1]), ...d.slice(7, 14).map((x) => [x, 2])];
  assert.equal(m.nivelRampa({ config: CFG, dia: d[14], historico: hist(base) }).nivel, 3);
  assert.equal(m.nivelRampa({ config: CFG, dia: d[14], historico: hist(base.map(([x, n]) => (x === d[13] ? [x, 0, { qc_falha: true }] : [x, n]))) }).nivel, 1);
  assert.equal(m.nivelRampa({ config: CFG, dia: "2026-11-10", historico: hist(days(11, "2026-10-12").map((x) => [x, 3])) }).nivel, 1);
  assert.deepEqual(m.nivelRampa({ config: CFG, dia: d[14], historico: hist(base), avisoHoje: true }).slots, []);
  const r1 = m.nivelRampa({ config: CFG, dia: "2026-11-10" });
  assert.equal(m.decisaoSlot({ rampa: r1, slot: "dica" }).publicar, true);
  assert.equal(m.decisaoSlot({ rampa: r1, slot: "oferta" }).publicar, false);
  assert.equal(m.decisaoSlot({ rampa: r1, slot: "dica", publicadosHoje: 1 }).publicar, false);
  assert.equal(m.decisaoSlot({ rampa: r1, slot: "dica", congelado: true }).publicar, false);
  assert.equal(m.avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "allowed" })).estado, "ok");
  assert.equal(m.avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "disallowed" })).estado, "restricao");
  assert.equal(m.avaliarPreflight(chan({ privacyStatus: "private", longUploadsStatus: "allowed" })).estado, "restricao");
  assert.equal(m.avaliarPreflight({ ok: false, status: 500 }).estado, "indisponivel");
  assert.equal(m.avaliarPosUpload({ privacy_status: "private" }).estado, "restricao");
  const reg = { desde: "2026-11-12" };
  assert.equal(m.congelamentoAtivo({ config: { canal: { congelamento_liberado_em: "2026-11-11" } }, registro: reg }), true);
  assert.equal(m.congelamentoAtivo({ config: { canal: { congelamento_liberado_em: "2026-11-12" } }, registro: reg }), false);
  const mp = new Map(); let puts = 0; const kv = { get: async (k) => mp.get(k) ?? null, put: async (k, v) => { puts++; mp.set(k, v); } };
  await m.gravarUmaVez(kv, "k", 1); await m.gravarUmaVez(kv, "k", 2);
  assert.equal(puts, 1);
}

// Bateria do dispatcher (sem 422 com workflow desativado; slots da rampa; congelamento).
const WF = "youtube-autonomous-short.yml";
async function bateriaDispatcher(m) {
  const now = Date.parse("2026-11-10T14:30:00Z"), late = Date.parse("2026-11-10T23:30:00Z");
  assert.ok(!m.decide({ now, workflowStates: { [WF]: "disabled_manually" } }).some((e) => e.workflow === WF));
  assert.ok(m.decide({ now, workflowStates: { [WF]: "active" } }).some((e) => e.workflow === WF));
  assert.ok(!m.decide({ now: Date.parse("2026-11-10T14:27:00Z"), workflowStates: { [WF]: "unknown" } }).some((e) => e.workflow === WF));
  assert.ok(m.decide({ now: Date.parse("2026-11-10T14:07:00Z"), workflowStates: { [WF]: "unknown" } }).some((e) => e.workflow === WF));
  assert.deepEqual(m.decide({ now: late, shortSlots: ["dica"], kvDone: { youtube_dica: true } }).filter((e) => e.workflow === WF), []);
  assert.deepEqual(m.shortSlotsAllowed({ config: CFG, dia: "2026-11-20", congelamento: { desde: "2026-11-15" } }).slots, []);
  assert.deepEqual(m.shortSlotsAllowed({ config: CFG, dia: "2026-11-20" }).slots, ["dica"]);
}

// Bateria da integração no Short: planos publicáveis sem WhatsApp, CTA na política em todos os modos.
const PROIBIDO = /whats\s*-?\s*app|\bzap\b|wa\.me|lista\s+de\s+espera/i;
async function bateriaShort(m) {
  for (const day of days(45, "2026-10-12")) for (const slot of ["dica", "calc", "oferta"]) for (const mode of [{}, { hotmartOpen: true }]) {
    const p = m.planSlot(day, slot, mode);
    assert.equal(p.gate.action, "publish", `${day} ${slot}`);
    assert.doesNotMatch([p.title, p.description, p.speech, ...Object.values(p.screen)].join("\n"), PROIBIDO);
    assert.match(p.link, /^https:\/\/vendas\.zevanory\.api\.br\/(hotmart\/[a-z-]+|calculadora-[a-z-]+)\?utm_source=youtube/);
  }
  const bad = m.planSlot("2026-11-10", "oferta", { salesOpen: true });
  assert.equal(bad.gate.action, "discard");
}

// Bateria do crosspost: Telegram desligado por decisão do proprietário (F0 nº 7) mesmo com credenciais presentes.
async function bateriaCrosspost(m) {
  assert.deepEqual([...m.OWNER_DISABLED_CHANNELS], ["telegram"]);
  const mp = new Map(), kv = { get: async (k) => mp.get(k) ?? null, put: async (k, v) => { mp.set(k, v); }, putBinary: async (k, v) => { mp.set(k, v); } };
  const tg = [];
  const fetchImpl = async (url) => { if (String(url).includes("api.telegram.org")) tg.push(url); return { ok: true, status: 200, json: async () => (String(url).includes("api.telegram.org") ? { ok: true, result: { message_id: 1, chat: { username: "z" } } } : { connected: false }) }; };
  const r = await m.crosspost({ day: "2026-10-12", slot: "oferta", mp4: Buffer.from("x"), env: { TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_CHANNEL_ID: "@z" }, kv, fetchImpl, sleep: async () => {}, salesOpen: false, hotmartOpen: false });
  assert.equal(r.telegram_video, "desligado:canal_desligado_decisao_proprietario");
  assert.equal(tg.length, 0);
  // NC-01 (DEC-23): sem prova aprovada, IG/FB bloqueados e 0 chamadas à Graph API, mesmo com META_* presentes.
  const graph = [];
  const gfetch = async (url, o = {}) => {
    const u = String(url);
    if (/graph(-video)?\.facebook\.com/.test(u)) { graph.push(u); return { ok: true, status: 200, json: async () => (u.endsWith("/media") ? { id: "c1" } : u.includes("status_code") ? { status_code: "FINISHED" } : u.endsWith("/media_publish") ? { id: "9" } : u.includes("permalink") ? { permalink: "https://www.instagram.com/reel/x/" } : { id: "7" }) }; }
    return { ok: true, status: 200, json: async () => ({ connected: false }) };
  };
  const metaEnv = { META_ACCESS_TOKEN: "t", INSTAGRAM_BUSINESS_ACCOUNT_ID: "17", META_PAGE_ID: "99" };
  const r2 = await m.crosspost({ day: "2026-10-12", slot: "oferta", mp4: Buffer.from("x"), env: metaEnv, kv, fetchImpl: gfetch, sleep: async () => {}, salesOpen: false, hotmartOpen: false });
  assert.equal(r2.instagram, "bloqueado:dec23_sem_prova"); assert.equal(graph.length, 0);
  const prova = { teste_permissao_ok: true, prova_instagram_media_id: "1", prova_facebook_video_id: "2", aprovado_por: "proprietario", aprovado_em: "2026-11-11" };
  assert.equal(m.metaLiberada(prova), true);
  assert.equal(m.metaLiberada({ ...prova, aprovado_por: "claude" }), false);
  // NC-02: só com o Short PÚBLICO registrado e o canal não congelado.
  const k2 = new Map(), kv2 = { get: async (k) => k2.get(k) ?? null };
  assert.equal((await m.youtubePublicoENaoCongelado({ kv: kv2, day: "2026-11-12", slot: "dica" })).ok, false);
  k2.set("zpc:acquisition:daily:2026-11-12:youtube_dica", JSON.stringify({ status: "publicado", privacy: "private" }));
  assert.equal((await m.youtubePublicoENaoCongelado({ kv: kv2, day: "2026-11-12", slot: "dica" })).ok, false);
  k2.set("zpc:acquisition:daily:2026-11-12:youtube_dica", JSON.stringify({ status: "publicado", privacy: "public" }));
  assert.equal((await m.youtubePublicoENaoCongelado({ kv: kv2, day: "2026-11-12", slot: "dica" })).ok, true);
  k2.set("zpc:shorts:congelado:v1", JSON.stringify({ desde: "2026-11-12" }));
  assert.equal((await m.youtubePublicoENaoCongelado({ kv: kv2, day: "2026-11-12", slot: "dica" })).ok, false);
}

const BATERIA = { retomada: bateriaRetomada, dispatcher: bateriaDispatcher, short: bateriaShort, crosspost: bateriaCrosspost };

const MUTANTES = [
  ["M01", "retomada", 'whats\\s*-?\\s*app|uótsap|\\bzap(?:zap)?\\b|wa\\.me\\b|api\\.whatsapp\\.com', "(?!)"],
  ["M02", "retomada", "lista\\s+de\\s+espera|waitlist", "(?!)"],
  ["M03", "retomada", "if (!hotmart && !calc) return", "if (false) return"],
  ["M04", "retomada", "if (hotmart && hotmartOpen !== true) return", "if (false) return"],
  ["M05", "retomada", 'q.get("utm_source") !== "youtube" || !q.get("utm_medium") || ', ""],
  ["M06", "retomada", "if (h.aviso === true || !(Number(h.publicados) >= atual.por_dia)) { limpos = 0; continue; }", "if (h.aviso === true) { limpos = 0; continue; }"],
  ["M07", "retomada", "limpos >= atual.dias_limpos_para_subir &&", "limpos >= atual.dias_limpos_para_subir - 1 &&"],
  ["M08", "retomada", "nivel = Math.max(1, nivel - 1); limpos = 0; continue;", "limpos = 0; continue;"],
  ["M09", "retomada", "if (!(Number(publicadosHoje) < rampa.por_dia))", "if (false)"],
  ["M10", "retomada", 'if (congelado === true) return { publicar: false, motivo: "canal_congelado" };', ""],
  ["M11", "retomada", 'if (st.longUploadsStatus === "disallowed") motivos.push', 'if (st.longUploadsStatus === "nunca") motivos.push'],
  ["M12", "retomada", 'if (st.privacyStatus !== "public") motivos.push', "if (false) motivos.push"],
  ["M13", "retomada", 'if (!resp || resp.ok !== true) return { estado: "indisponivel"', 'if (!resp || resp.ok !== true) return { estado: "ok"'],
  ["M14", "retomada", "if (result.privacy_status !== pedido)", "if (false)"],
  ["M15", "retomada", "return !(diaValido(lib) && lib >= registro.desde);", "return !diaValido(lib);"],
  ["M16", "retomada", 'if ((await kv.get(chave)) != null) return { gravado: false, motivo: "ja_registrado" };', ""],
  ["M17", "retomada", "if (d >= inicio) out.push(d);", "out.push(d);"],
  ["M18", "retomada", "if (avisoHoje === true) return", "if (false) return"],
  ["D01", "dispatcher", 'return { dispatch: false, status: "workflow_" +', 'return { dispatch: true, status: "workflow_" +'],
  ["D02", "dispatcher", "minutes % janela < 20 ?", "true ?"],
  ["D03", "dispatcher", "if (e.inputs.slot && Array.isArray(shortSlots) && !shortSlots.includes(e.inputs.slot)) continue;", ""],
  ["D04", "dispatcher", 'if (congelado || config?.canal?.aviso_manual === true) return { slots: [], motivo: "canal_congelado" };', ""],
  ["D05", "dispatcher", "if (!workflowGate(workflowStates[e.workflow], L.minutes, sondagemMin).dispatch) continue;", ""],
  ["Y01", "short", "return v.length ? {", "return false ? {"],
  ["Y02", "short", ".filter(u => !VALUE_RISK.test(u) && textoProibido(u).length === 0)", ".filter(u => !VALUE_RISK.test(u))"],
  ["Y03", "short", 'const page = new URL(shortUrl(calculatorFor(day).slug, "oferta_" + PRODUCT_PAGES[entry.product.sku].replace(/-/g, "_")));', "const page = productPage;"],
  ["T01", "crosspost", 'export const OWNER_DISABLED_CHANNELS = Object.freeze(["telegram"]);', "export const OWNER_DISABLED_CHANNELS = Object.freeze([]);"],
  ["T02", "crosspost", 'if (OWNER_DISABLED_CHANNELS.includes("telegram")) report.telegram_video', 'if (false) report.telegram_video'],
  ["N01", "crosspost", "if (!metaLiberada(metaProva)) { report[ch]", "if (false) { report[ch]"],
  ["N02", "crosspost", ' && r?.aprovado_por === "proprietario"', ""],
  ["N03", "crosspost", 'if (yt?.status !== "publicado" || yt?.privacy !== "public") return', "if (false) return"],
  ["N04", "crosspost", 'if (congelamentoAtivo({ config, registro: parse(await kv.get(CHAVE_CONGELADO)) })) return', "if (false) return"],
  ["Y04", "short", 'path: "hotmart/" + hotmart.slug', 'path: "hotmart/" + hotmart.slug + "-zap"'],
];

test("linha de base: as três baterias passam no código original", async () => {
  for (const kind of Object.keys(BATERIA)) await BATERIA[kind](await load(kind, null, null));
});

for (const [id, kind, find, replace] of MUTANTES) {
  test(`mutante ${id} (${kind}) é morto`, async () => {
    const m = await load(kind, find, replace);
    await assert.rejects(() => BATERIA[kind](m), `${id} sobreviveu`);
  });
}
