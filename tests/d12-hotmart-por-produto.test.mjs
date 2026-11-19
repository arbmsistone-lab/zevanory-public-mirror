import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { readHotmartSwitch, resetHotmartSwitchCache, handleSalesControl, HOTMART_SALES_KEY, hotmartRecordProducts, hotmartProductOpen, HOTMART_PRODUCT_SLUGS } from "../worker/sales-control.mjs";
import { hotmartKitsOpen, purchaseOpenFor } from "../worker/sales-lock-content.mjs";
import { maybeAlertFirstOrder, retryFirstOrderAlert, brtDay, firstOrderAlertText, FIRST_ORDER_ALERT_PREFIX, MAX_ATTEMPTS } from "../worker/hotmart-first-order-alert.mjs";
import { handleDigitalHotmartNc012 } from "../worker/cp-nc012-digital-hotmart.mjs";

// D12 (19/11/2026, VC-H): modo Hotmart POR PRODUTO e aviso único do 1º pedido elegível do dia (BRT).
const ALL = ["combo-ia-vendas", "ia-na-pratica", "lucro-e-caixa", "negocio-completo", "vendas-na-pratica"];
const record = (extra = {}) => ({ enabled: true, authorization: "LIBERAR VENDAS", channel: "hotmart", by: "owner", at: new Date(Date.now() - 60000).toISOString(), ref: "https://github.com/arbmsistone-lab/zevanory-public-mirror/issues/1", products: ["ia-na-pratica"], ...extra });
const memKv = (init = {}) => { const m = new Map(Object.entries(init)); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list({ prefix = "" } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; } }; };
const envWith = (rec, extra = {}) => ({ ZEVANORY_PRIVATE_ARTIFACTS: memKv(rec === undefined ? {} : { [HOTMART_SALES_KEY]: JSON.stringify(rec) }), ...extra });
const read = async (env) => { resetHotmartSwitchCache(); const v = await readHotmartSwitch(env); resetHotmartSwitchCache(); return v; };

test("D12.1 lista válida abre só os kits listados; status público expõe a lista", async () => {
  const env = envWith(record());
  const sw = await read(env);
  assert.deepEqual([sw.open, sw.products], [true, ["ia-na-pratica"]], "[D12.1] leitura");
  assert.equal(hotmartProductOpen(sw, "ia-na-pratica"), true);
  for (const s of ALL.filter((x) => x !== "ia-na-pratica")) assert.equal(hotmartProductOpen(sw, s), false, s);
  resetHotmartSwitchCache();
  const body = await (await handleSalesControl(new Request("https://zevanory.api.br/api/sales/hotmart-status"), env)).json();
  resetHotmartSwitchCache();
  assert.deepEqual([body.open, body.channel, body.products], [true, "hotmart", ["ia-na-pratica"]], "[D12.1] status");
  assert.deepEqual(HOTMART_PRODUCT_SLUGS.slice().sort(), ALL, "[D12.1] fonte única = os 5 kits");
});

test("D12.2 falha fechada: sem lista, vazia, desconhecida, repetida, assinatura ou mais de 5 => fechado para todos", async () => {
  const bad = [undefined, [], ["nao-existe"], ["ia-na-pratica", "ia-na-pratica"], ["conteudo-pronto"], "ia-na-pratica", [...ALL, "ia-na-pratica"], [7]];
  for (const products of bad) {
    const rec = record(); if (products === undefined) delete rec.products; else rec.products = products;
    const sw = await read(envWith(rec));
    assert.deepEqual([sw.open, sw.products], [false, []], "[D12.2] " + JSON.stringify(products));
    assert.equal(hotmartRecordProducts(rec), null, "[D12.2] validador " + JSON.stringify(products));
  }
  const fechado = await read(envWith({ enabled: false, at: new Date().toISOString(), by: "owner-close" }));
  assert.equal(fechado.open, false, "[D12.2] registro de fechamento do zevanory-close-sales");
});

test("D12.3 publicadores automáticos só com os 5 kits; compra por produto; Conteúdo Pronto nunca", async () => {
  resetHotmartSwitchCache();
  assert.equal(await hotmartKitsOpen(envWith(record())), false, "[D12.3] parcial => divulgação automática fechada");
  resetHotmartSwitchCache();
  assert.equal(await purchaseOpenFor(envWith(record()), "ia-na-pratica"), true, "[D12.3] kit liberado");
  resetHotmartSwitchCache();
  assert.equal(await purchaseOpenFor(envWith(record()), "ZEV-VEN-011"), false, "[D12.3] kit não liberado");
  resetHotmartSwitchCache();
  assert.equal(await purchaseOpenFor(envWith(record({ products: ALL })), "conteudo-pronto"), false, "[D12.3] assinatura fechada");
  resetHotmartSwitchCache();
  assert.equal(await hotmartKitsOpen(envWith(record({ products: ALL }))), true, "[D12.3] 5 kits => modo completo");
  resetHotmartSwitchCache();
});

// Aviso do 1º pedido elegível do dia.
const T = Date.parse("2026-11-20T13:00:00Z"); // 10:00 BRT
const tg = () => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); } }; };
const alertEnv = (rec = record()) => envWith(rec, { TELEGRAM_ALERT: "1234567:" + "a".repeat(30) + "|-100123456" });

test("D12.4 aviso único no 1º pedido elegível do dia; duplicata, 2º pedido e produto não liberado não avisam", async () => {
  const env = alertEnv(), t = tg();
  resetHotmartSwitchCache();
  const a = await maybeAlertFirstOrder(env, { event: "PURCHASE_BILLET_PRINTED", productId: "8704733", recorded: true, now: T, fetchImpl: t.fetchImpl });
  assert.deepEqual([a.alerted, t.calls.length], [true, 1], "[D12.4] PIX/boleto pendente avisa");
  const b = await maybeAlertFirstOrder(env, { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: T + 600000, fetchImpl: t.fetchImpl });
  assert.deepEqual([b.alerted, b.reason, t.calls.length], [false, "ja_avisado_hoje", 1], "[D12.4] 2º evento do mesmo dia");
  const env2 = alertEnv(), t2 = tg();
  resetHotmartSwitchCache();
  assert.equal((await maybeAlertFirstOrder(env2, { event: "PURCHASE_APPROVED", productId: "8704733", recorded: false, now: T, fetchImpl: t2.fetchImpl })).reason, "duplicata", "[D12.4] duplicata");
  assert.equal((await maybeAlertFirstOrder(env2, { event: "PURCHASE_APPROVED", productId: "8704826", recorded: true, now: T, fetchImpl: t2.fetchImpl })).reason, "produto_nao_liberado", "[D12.4] kit não liberado");
  assert.equal((await maybeAlertFirstOrder(env2, { event: "PURCHASE_REFUNDED", productId: "8704733", recorded: true, now: T, fetchImpl: t2.fetchImpl })).reason, "evento_nao_elegivel", "[D12.4] reembolso");
  assert.equal((await maybeAlertFirstOrder(env2, { event: "PURCHASE_APPROVED", productId: "8709787", recorded: true, now: T, fetchImpl: t2.fetchImpl })).reason, "produto_fora_da_lista", "[D12.4] fora da lista");
  assert.equal(t2.calls.length, 0, "[D12.4] nenhum envio");
  resetHotmartSwitchCache();
});

test("D12.5 o dia é o de Brasília: 23:30 BRT e 00:30 BRT do dia seguinte são dois dias", async () => {
  assert.equal(brtDay(Date.parse("2026-11-20T02:30:00Z")), "2026-11-19", "[D12.5] 23:30 BRT");
  assert.equal(brtDay(Date.parse("2026-11-20T03:30:00Z")), "2026-11-20", "[D12.5] 00:30 BRT");
  const env = alertEnv(), t = tg();
  resetHotmartSwitchCache();
  assert.equal((await maybeAlertFirstOrder(env, { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: Date.parse("2026-11-20T02:30:00Z"), fetchImpl: t.fetchImpl })).alerted, true);
  assert.equal((await maybeAlertFirstOrder(env, { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: Date.parse("2026-11-20T03:30:00Z"), fetchImpl: t.fetchImpl })).alerted, true, "[D12.5] novo dia BRT avisa de novo");
  assert.deepEqual([...env.ZEVANORY_PRIVATE_ARTIFACTS.m.keys()].filter((k) => k.endsWith(":enviado")).sort(), [FIRST_ORDER_ALERT_PREFIX + "2026-11-19:enviado", FIRST_ORDER_ALERT_PREFIX + "2026-11-20:enviado"]);
  resetHotmartSwitchCache();
});

test("D12.6 texto sem dado pessoal; falha do Telegram ou segredo ausente nunca lança", async () => {
  const txt = firstOrderAlertText({ name: "IA na Prática", kind: "pedido aprovado", now: T });
  assert.match(txt, /1º pedido do dia do IA na Prática .* 10:00 BRT/);
  assert.doesNotMatch(txt, /@|HF-|R\$|\d{6,}/, "[D12.6] sem e-mail, transação, valor ou ID");
  resetHotmartSwitchCache();
  const semSegredo = await maybeAlertFirstOrder(envWith(record()), { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: T, fetchImpl: async () => { throw new Error("não deveria chamar"); } });
  assert.deepEqual([semSegredo.alerted, semSegredo.reason], [false, "telegram_nao_configurado"]);
  resetHotmartSwitchCache();
  const falha = await maybeAlertFirstOrder(alertEnv(), { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: T, fetchImpl: async () => { throw new Error("rede"); } });
  assert.deepEqual([falha.alerted, falha.reason], [false, "telegram_incerto"]);
  resetHotmartSwitchCache();
});

test("D12.7 webhook Hotmart real: 1º evento novo avisa, repetição não; a resposta do webhook não muda", async () => {
  const hottok = "hottok-ficticio-d12-000000000000";
  const env = { ...alertEnv(), HOTMART_HOTTOK: hottok };
  const calls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith("https://api.telegram.org/")) { calls.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); } throw new Error("rede bloqueada no teste"); };
  try {
    const body = { version: "2.0.0", event: "PURCHASE_APPROVED", data: { product: { id: 8704733, name: "ZEVANORY IA na Prática" }, buyer: { email: "comprador@example.invalid", first_name: "Teste" }, purchase: { transaction: "HP-D12-001", price: { value: 97 }, approved_date: T - 1000, payment: { type: "PIX" } }, commissions: [{ source: "PRODUCER", value: 85 }] } };
    const send = () => handleDigitalHotmartNc012(new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": hottok }, body: JSON.stringify(body) }), env, { now: T });
    resetHotmartSwitchCache();
    const r1 = await send(); const j1 = await r1.json();
    resetHotmartSwitchCache();
    const r2 = await send(); const j2 = await r2.json();
    assert.deepEqual([r1.status, j1.ok, r2.status, j2.duplicate], [200, true, 200, true], "[D12.7] respostas");
    assert.equal(calls.length, 1, "[D12.7] um único aviso");
    assert.doesNotMatch(JSON.stringify(calls), /example\.invalid|HP-D12/, "[D12.7] aviso sem comprador nem transação");
  } finally { globalThis.fetch = realFetch; resetHotmartSwitchCache(); }
});

// Reauditoria GPT-6 (9c9f5f32): o Workers KV aceita 1 escrita por segundo por chave. O KV estrito abaixo RECUSA
// (429) qualquer regravação da mesma chave em menos de 1 s de relógio real; os testes rodam em milissegundos, então
// qualquer regravação no fluxo é detectada. Só "<dia>:enviado" (após 2xx) suprime; o cron recupera sem novo pedido.
const strictKv = () => { const kv = memKv(); const last = new Map(); const put = kv.put.bind(kv); kv.rejected = []; kv.put = async (k, v, o) => { const t = Date.now(); if (last.has(k) && t - last.get(k) < 1000) { kv.rejected.push(k); throw new Error("429 KV PUT failed: Too Many Requests"); } last.set(k, t); return put(k, v, o); }; return kv; };
const strictEnv = (secret = true) => { const kv = strictKv(); kv.m.set(HOTMART_SALES_KEY, JSON.stringify(record())); return { ZEVANORY_PRIVATE_ARTIFACTS: kv, ...(secret ? { TELEGRAM_ALERT: "1234567:" + "a".repeat(30) + "|-100123456" } : {}) }; };
const seq = (...outcomes) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); const o = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]; if (o === "timeout") throw new DOMException("timeout", "TimeoutError"); return new Response("{}", { status: o }); } }; };
const noSleep = async () => {};
const ev = (env, t, min = 0, event = "PURCHASE_APPROVED") => maybeAlertFirstOrder(env, { event, productId: "8704733", recorded: true, now: T + min * 60000, fetchImpl: t.fetchImpl, sleepImpl: noSleep });
const cron = (env, t, min) => retryFirstOrderAlert(env, { now: T + min * 60000, fetchImpl: t.fetchImpl, sleepImpl: noSleep });
const has = (env, suffix, day = "2026-11-20") => env.ZEVANORY_PRIVATE_ARTIFACTS.m.has(FIRST_ORDER_ALERT_PREFIX + day + suffix);

test("D12.8 2xx rápido: suprime em sequência imediata, sem regravar chave nenhuma (limite de 1 escrita/s do KV)", async () => {
  resetHotmartSwitchCache();
  const env = strictEnv(), t = seq(200);
  assert.deepEqual([(await ev(env, t, 0)).alerted, has(env, ":enviado")], [true, true], "[D12.8] confirmado");
  assert.deepEqual([(await ev(env, t, 0)).reason, (await ev(env, t, 0, "PURCHASE_COMPLETE")).reason, t.calls.length], ["ja_avisado_hoje", "ja_avisado_hoje", 1], "[D12.8] nada mais no dia");
  assert.deepEqual((await cron(env, t, 60)).results.map((r) => r.reason), ["ja_avisado_hoje"], "[D12.8] cron não reenvia");
  assert.deepEqual([env.ZEVANORY_PRIVATE_ARTIFACTS.rejected, t.calls.length], [[], 1], "[D12.8] nenhuma escrita recusada");
  resetHotmartSwitchCache();
});

test("D12.9 1º pedido se recupera SEM outro pedido: 503, timeout e segredo ausente ficam pendentes e o cron avisa", async () => {
  resetHotmartSwitchCache();
  const a = strictEnv(), ta = seq(503, 200);
  assert.equal((await ev(a, ta, 0)).reason, "telegram_503");
  assert.deepEqual([has(a, ":pedido"), has(a, ":enviado")], [true, false], "[D12.9] pendente");
  assert.deepEqual((await cron(a, ta, 47)).results, [{ day: "2026-11-20", alerted: true, reason: null }], "[D12.9] cron recupera o 503");
  assert.deepEqual([(await cron(a, ta, 107)).results[0].reason, ta.calls.length], ["ja_avisado_hoje", 2], "[D12.9] e para");
  assert.match(ta.calls[1].text, /1º pedido do dia do .* 10:00 BRT/, "[D12.9] hora do pedido, não do reenvio");
  const b = strictEnv(), tb = seq("timeout", 200);
  assert.equal((await ev(b, tb, 0)).reason, "telegram_incerto");
  assert.equal((await cron(b, tb, 60)).results[0].alerted, true, "[D12.9] timeout incerto: reenvio (duplicata aceita)");
  const c = strictEnv(false), tc = seq(200);
  assert.equal((await ev(c, tc, 0)).reason, "telegram_nao_configurado");
  assert.deepEqual([has(c, ":pedido"), has(c, ":enviado"), tc.calls.length], [true, false, 0], "[D12.9] sem segredo: pendente, sem envio");
  c.TELEGRAM_ALERT = "1234567:" + "a".repeat(30) + "|-100123456";
  assert.equal((await cron(c, tc, 60)).results[0].alerted, true, "[D12.9] segredo configurado depois: cron avisa");
  const d = strictEnv(), td = seq(503, 200), late = Date.parse("2026-11-21T02:50:00Z"); // 23:50 BRT do dia 20
  assert.equal((await maybeAlertFirstOrder(d, { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: late, fetchImpl: td.fetchImpl, sleepImpl: noSleep })).reason, "telegram_503");
  const r = await retryFirstOrderAlert(d, { now: Date.parse("2026-11-21T03:00:00Z"), fetchImpl: td.fetchImpl, sleepImpl: noSleep }); // 00:00 BRT do dia 21
  assert.deepEqual(r.results.map((x) => [x.day, x.alerted]), [["2026-11-20", true]], "[D12.9] virada do dia BRT: cron recupera o de ontem");
  for (const e of [a, b, c, d]) assert.deepEqual(e.ZEVANORY_PRIVATE_ARTIFACTS.rejected, [], "[D12.9] nenhuma escrita recusada");
  resetHotmartSwitchCache();
});

test("D12.10 limite de tentativas, confirmação não gravada e cron sem pedido", async () => {
  resetHotmartSwitchCache();
  const e = strictEnv(), t = seq(500);
  await ev(e, t, 0);
  for (let h = 1; h <= MAX_ATTEMPTS + 2; h++) await cron(e, t, h * 60);
  assert.equal(t.calls.length, MAX_ATTEMPTS, "[D12.10] no máximo MAX_ATTEMPTS envios no dia (em série)");
  assert.equal((await cron(e, t, 600)).results[0].reason, "tentativas_esgotadas");
  const f = strictEnv(), tf = seq(200), kv = f.ZEVANORY_PRIVATE_ARTIFACTS, put = kv.put;
  kv.put = async (k, v, o) => { if (k.endsWith(":enviado")) throw new Error("KV indisponível"); return put(k, v, o); };
  assert.deepEqual(await ev(f, tf, 0), { alerted: true, reason: "confirmacao_nao_gravada" }, "[D12.10] aviso saiu, confirmação perdida");
  kv.put = put;
  assert.equal((await cron(f, tf, 60)).results[0].alerted, true, "[D12.10] confirmação perdida => duplicata (preferida ao silêncio)");
  const o = alertEnv(), to = seq(503, 503, 200);
  await ev(o, to, 0); await ev(o, to, 30, "PURCHASE_COMPLETE");
  assert.deepEqual(JSON.parse(o.ZEVANORY_PRIVATE_ARTIFACTS.m.get(FIRST_ORDER_ALERT_PREFIX + "2026-11-20:pedido")), { at: new Date(T).toISOString(), product: "ia-na-pratica", event: "PURCHASE_APPROVED" }, "[D12.10] o registro do 1º pedido nunca é regravado");
  assert.equal((await cron(o, to, 60)).results[0].alerted, true);
  assert.match(to.calls[2].text, /\(pedido aprovado\) às 10:00 BRT/, "[D12.10] o aviso recuperado é o do 1º pedido");
  const g = strictEnv(), tg2 = seq(200);
  assert.deepEqual([(await cron(g, tg2, 60)).results, tg2.calls.length], [[], 0], "[D12.10] sem pedido no dia, o cron não envia nada");
  resetHotmartSwitchCache();
});

test("D12.11 eventos concorrentes: 1 a 2 avisos, nunca zero; depois, nada mais (nem pelo cron)", async () => {
  resetHotmartSwitchCache();
  const env = strictEnv(), t = seq(200);
  const rs = await Promise.all([ev(env, t, 0), ev(env, t, 0)]);
  assert.ok(t.calls.length >= 1 && t.calls.length <= 2, "[D12.11] envios=" + t.calls.length);
  assert.ok(rs.some((r) => r.alerted), "[D12.11] ao menos um confirmado");
  assert.equal((await ev(env, t, 1)).reason, "ja_avisado_hoje");
  assert.equal((await cron(env, t, 60)).results[0].reason, "ja_avisado_hoje");
  resetHotmartSwitchCache();
});

test("D12.12 o cron horário chama a recuperação do aviso", () => {
  const w = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  assert.match(w, /if\(controller\?\.cron==="0 \* \* \* \*"\)await retryFirstOrderAlert\(normalized\)/);
});

// Reauditoria GPT-6 (51514939): gravação de <dia>:pedido falha + Telegram 503 + postback repetido (duplicata).
// O cron reconstrói o MESMO pedido a partir do registro de vendas e avisa, sem depender de uma 2ª compra.
const metaKv = (failSuffix) => { const m = new Map(), meta = new Map(), last = new Map(); return { m, rejected: [],
  async get(k) { return m.has(k) ? m.get(k) : null; },
  async put(k, v, o) { if (failSuffix && k.endsWith(failSuffix)) throw new Error("KV PUT failed: 500"); const t = Date.now(); if (last.has(k) && t - last.get(k) < 1000) { this.rejected.push(k); throw new Error("429"); } last.set(k, t); m.set(k, String(v)); meta.set(k, o?.metadata ?? null); },
  async delete(k) { m.delete(k); meta.delete(k); },
  async list({ prefix = "", limit = 1000, cursor } = {}) { const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); const start = Number(cursor || 0), page = all.slice(start, start + limit), end = start + page.length; return { keys: page.map((name) => ({ name, metadata: meta.get(name) ?? null })), list_complete: end >= all.length, ...(end < all.length ? { cursor: String(end) } : {}) }; } }; };

test("D12.13 falha ao gravar o pedido + 503 + postback repetido: o cron recupera o MESMO pedido pelo registro de vendas", async () => {
  const hottok = "hottok-ficticio-d12-000000000000";
  const kv = metaKv(":pedido"); kv.m.set(HOTMART_SALES_KEY, JSON.stringify(record()));
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, HOTMART_HOTTOK: hottok, TELEGRAM_ALERT: "1234567:" + "a".repeat(30) + "|-100123456" };
  const calls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith("https://api.telegram.org/")) { calls.push(JSON.parse(init.body)); return new Response("{}", { status: 503 }); } throw new Error("rede bloqueada no teste"); };
  try {
    const body = { version: "2.0.0", event: "PURCHASE_APPROVED", data: { product: { id: 8704733, name: "ZEVANORY IA na Prática" }, buyer: { email: "comprador@example.invalid", first_name: "Teste" }, purchase: { transaction: "HP-D12-013", price: { value: 97 }, approved_date: T, payment: { type: "PIX" } }, commissions: [{ source: "PRODUCER", value: 85 }] } };
    const send = () => handleDigitalHotmartNc012(new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": hottok }, body: JSON.stringify(body) }), env, { now: T });
    resetHotmartSwitchCache();
    assert.equal((await send()).status, 200, "[D12.13] webhook responde 200");
    assert.deepEqual([calls.length, kv.m.has(FIRST_ORDER_ALERT_PREFIX + "2026-11-20:pedido"), kv.m.has(FIRST_ORDER_ALERT_PREFIX + "2026-11-20:enviado")], [1, false, false], "[D12.13] 503 e pedido NÃO gravado");
    resetHotmartSwitchCache();
    assert.equal((await (await send()).json()).duplicate, true, "[D12.13] postback repetido = duplicata");
    assert.equal(calls.length, 1, "[D12.13] a duplicata não tenta de novo");
    const tc = seq(200); resetHotmartSwitchCache();
    const r = await retryFirstOrderAlert(env, { now: T + 47 * 60000, fetchImpl: tc.fetchImpl, sleepImpl: noSleep });
    assert.deepEqual(r.results, [{ day: "2026-11-20", alerted: true, reason: null }], "[D12.13] cron recupera sem 2ª compra");
    assert.match(tc.calls[0].text, /IA na Prática \(pedido aprovado\) às 10:00 BRT/, "[D12.13] é o mesmo pedido (hora do payload)");
    resetHotmartSwitchCache();
    assert.deepEqual([(await retryFirstOrderAlert(env, { now: T + 107 * 60000, fetchImpl: tc.fetchImpl, sleepImpl: noSleep })).results, tc.calls.length], [[], 1], "[D12.13] e para (enviado confirmado)");
    assert.doesNotMatch(JSON.stringify([calls, tc.calls]), /example\.invalid|HP-D12/, "[D12.13] sem dado pessoal");
    // Contraprovas: kit não liberado no interruptor ou evento de outro dia BRT não geram aviso pelo registro.
    const kv2 = metaKv(":pedido"); for (const [k, v] of kv.m) if (k.startsWith("zpc:sales:v1:ev:")) await kv2.put(k, v, { metadata: JSON.parse(v) });
    kv2.m.set(HOTMART_SALES_KEY, JSON.stringify(record({ products: ["vendas-na-pratica"] })));
    const t2 = seq(200); resetHotmartSwitchCache();
    assert.deepEqual([(await retryFirstOrderAlert({ ...env, ZEVANORY_PRIVATE_ARTIFACTS: kv2 }, { now: T + 60 * 60000, fetchImpl: t2.fetchImpl, sleepImpl: noSleep })).results, t2.calls.length], [[], 0], "[D12.13] kit fora da lista");
    kv2.m.set(HOTMART_SALES_KEY, JSON.stringify(record()));
    resetHotmartSwitchCache();
    assert.deepEqual([(await retryFirstOrderAlert({ ...env, ZEVANORY_PRIVATE_ARTIFACTS: kv2 }, { now: T + 3 * 86400000, fetchImpl: t2.fetchImpl, sleepImpl: noSleep })).results, t2.calls.length], [[], 0], "[D12.13] pedido de outro dia");
    // Evento não elegível (cancelado/reembolsado) no registro não gera aviso.
    const kv3 = metaKv(); kv3.m.set(HOTMART_SALES_KEY, JSON.stringify(record()));
    for (const ev of ["PURCHASE_CANCELED", "PURCHASE_REFUNDED"]) await kv3.put("zpc:sales:v1:ev:00:" + "0".repeat(32) + ":x:" + ev.toLowerCase() + ":" + "0".repeat(16), "{}", { metadata: { event: ev, facts: { at: new Date(T).toISOString(), productId: "8704733" } } });
    const t3 = seq(200); resetHotmartSwitchCache();
    assert.deepEqual([(await retryFirstOrderAlert({ ...env, ZEVANORY_PRIVATE_ARTIFACTS: kv3 }, { now: T + 60 * 60000, fetchImpl: t3.fetchImpl, sleepImpl: noSleep })).results, t3.calls.length], [[], 0], "[D12.13] evento não elegível");
  } finally { globalThis.fetch = realFetch; resetHotmartSwitchCache(); }
});
