import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { readHotmartSwitch, resetHotmartSwitchCache, handleSalesControl, HOTMART_SALES_KEY, hotmartRecordProducts, hotmartProductOpen, HOTMART_PRODUCT_SLUGS } from "../worker/sales-control.mjs";
import { hotmartKitsOpen, purchaseOpenFor } from "../worker/sales-lock-content.mjs";
import { maybeAlertFirstOrder, retryFirstOrderAlert, registerFirstOrderCandidate, txnHash, brtDay, firstOrderAlertText, FIRST_ORDER_ALERT_PREFIX, MAX_ATTEMPTS } from "../worker/hotmart-first-order-alert.mjs";
import { handleDigitalHotmartNc012 } from "../worker/cp-nc012-digital-hotmart.mjs";
import { salesEventRecord, SALES_EVENT_PREFIX } from "../worker/sales-ledger.mjs";

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

// Aviso do 1º pedido elegível do dia (rodada 4: ordem GPT-6 sobre e7fc388a). Tudo pelo webhook REAL.
// KV de teste: guarda metadados, pagina a listagem (1.000 por página, cursor) e é ESTRITO nas chaves do aviso: recusa (429)
// regravar a mesma chave em menos de 1 s de relógio real (limite do Workers KV). `fail(pred, n)` injeta n falhas de put.
const T = Date.parse("2026-11-20T13:00:00Z"); // 10:00 BRT
const HOTTOK = "hottok-ficticio-d12-000000000000";
const SECRET = "1234567:" + "a".repeat(30) + "|-100123456";
const testKv = () => { const m = new Map(), meta = new Map(), last = new Map(); let failPred = null, failLeft = 0; return { m, meta, rejected: [],
  fail(pred, n = 1) { failPred = pred; failLeft = n; },
  async get(k) { return m.has(k) ? m.get(k) : null; },
  async put(k, v, o) { if (failPred && failLeft > 0 && failPred(k)) { failLeft--; throw new Error("KV PUT failed: 500"); } if (k.startsWith(FIRST_ORDER_ALERT_PREFIX)) { const t = Date.now(); if (last.has(k) && t - last.get(k) < 1000) { this.rejected.push(k); throw new Error("429 KV PUT failed: Too Many Requests"); } last.set(k, t); } m.set(k, String(v)); meta.set(k, o?.metadata ?? null); },
  async delete(k) { m.delete(k); meta.delete(k); },
  async list({ prefix = "", limit = 1000, cursor } = {}) { const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); const start = Number(cursor || 0), page = all.slice(start, start + limit), end = start + page.length; return { keys: page.map((name) => ({ name, metadata: meta.get(name) ?? null })), list_complete: end >= all.length, ...(end < all.length ? { cursor: String(end) } : {}) }; } }; };
const hookEnv = ({ secret = true, products = ["ia-na-pratica"] } = {}) => { const kv = testKv(); kv.m.set(HOTMART_SALES_KEY, JSON.stringify(record({ products }))); return { ZEVANORY_PRIVATE_ARTIFACTS: kv, HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "", ...(secret ? { TELEGRAM_ALERT: SECRET } : {}) }; };
// Telegram simulado (fetch global, usado pelo webhook) com roteiro de respostas; outra rede é bloqueada.
const telegram = (...outcomes) => { const calls = []; const fetchImpl = async (url, init) => { if (!String(url).startsWith("https://api.telegram.org/")) throw new Error("rede bloqueada no teste"); calls.push(JSON.parse(init.body)); const o = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]; if (o === "timeout") throw new DOMException("timeout", "TimeoutError"); return new Response("{}", { status: o }); }; return { calls, fetchImpl }; };
const withFetch = async (tg, fn) => { const real = globalThis.fetch; globalThis.fetch = tg.fetchImpl; try { return await fn(); } finally { globalThis.fetch = real; resetHotmartSwitchCache(); } };
const payload = ({ txn = "HP-D12-001", event = "PURCHASE_APPROVED", productId = 8704733, at = T, dated = true } = {}) => ({ version: "2.0.0", event, data: { product: { id: productId, name: "ZEVANORY kit" }, buyer: { email: "comprador@example.invalid", first_name: "Teste" }, purchase: { transaction: txn, price: { value: 97 }, ...(dated ? { approved_date: at } : {}), payment: { type: "PIX" } }, commissions: [{ source: "PRODUCER", value: 85 }] } });
const hook = async (env, body, now = T) => { resetHotmartSwitchCache(); const r = await handleDigitalHotmartNc012(new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": HOTTOK }, body: JSON.stringify(body) }), env, { now }); return { status: r.status, body: await r.json() }; };
const cron = async (env, tg, now) => { resetHotmartSwitchCache(); return retryFirstOrderAlert(env, { now, fetchImpl: tg.fetchImpl, sleepImpl: async () => {} }); };
const H = 3600000;
const noPii = (tg) => assert.doesNotMatch(JSON.stringify(tg.calls), /example\.invalid|HP-D12|Teste/, "sem dado pessoal no aviso");

test("D12.4 2xx rápido: um aviso; postback repetido, COMPLETE, 2º pedido e cron não reenviam; nenhuma regravação de chave", () => {
  const env = hookEnv(), tg = telegram(200);
  return withFetch(tg, async () => {
    assert.equal((await hook(env, payload())).status, 200);
    assert.equal(tg.calls.length, 1, "[D12.4] aviso");
    assert.match(tg.calls[0].text, /1º pedido do dia do IA na Prática \(pedido aprovado\) às 10:00 BRT\./);
    assert.equal((await hook(env, payload())).body.duplicate, true);
    await hook(env, payload({ event: "PURCHASE_COMPLETE" }), T + 1000);
    await hook(env, payload({ txn: "HP-D12-002", at: T + 600000 }), T + 600000);
    assert.deepEqual((await cron(env, tg, T + H)).results, [], "[D12.4] cron sem pendência");
    assert.equal(tg.calls.length, 1, "[D12.4] nada mais no dia");
    assert.deepEqual(env.ZEVANORY_PRIVATE_ARTIFACTS.rejected, [], "[D12.4] nenhuma escrita recusada (1/s por chave)");
    noPii(tg);
  });
});

test("D12.5 aceite: falha ao gravar a pendência + Telegram 503 + reenvio do postback; o cron recupera o MESMO pedido", () => {
  const env = hookEnv(), kv = env.ZEVANORY_PRIVATE_ARTIFACTS, tg = telegram(503);
  return withFetch(tg, async () => {
    // (a) falha no registro durável do candidato => 503 ANTES do registro de vendas; nada gravado, nenhum envio.
    kv.fail((k) => k.includes(":txn:"));
    assert.equal((await hook(env, payload())).status, 503, "[D12.5] 503 para a Hotmart reenviar");
    assert.equal([...kv.m.keys()].some((k) => k.startsWith(SALES_EVENT_PREFIX)), false, "[D12.5] venda ainda não gravada");
    // (b) reentrega: a chave do dia falha depois do txn => 503 de novo; (c) reentrega: repara a chave do dia, Telegram 503.
    kv.fail((k) => k.endsWith(":candidato"));
    assert.equal((await hook(env, payload(), T + 60000)).status, 503);
    assert.equal((await hook(env, payload(), T + 120000)).status, 200, "[D12.5] reentrega conclui");
    assert.equal((await hook(env, payload(), T + 180000)).body.duplicate, true, "[D12.5] reenvio idempotente");
    assert.equal(tg.calls.length, 2, "[D12.5] duas tentativas no webhook, ambas 503");
    const h = await txnHash("HP-D12-001");
    assert.ok(kv.m.get(FIRST_ORDER_ALERT_PREFIX + "2026-11-20:candidato") === h && !kv.m.has(FIRST_ORDER_ALERT_PREFIX + "2026-11-20:enviado"), "[D12.5] pendente");
    // Sem outra compra: o cron envia o aviso do mesmo pedido (hora do payload), e depois para.
    const ok = telegram(200);
    assert.deepEqual((await cron(env, ok, T + H)).results, [{ day: "2026-11-20", alerted: true, reason: null }]);
    assert.match(ok.calls[0].text, /IA na Prática \(pedido aprovado\) às 10:00 BRT\./, "[D12.5] mesmo pedido");
    assert.deepEqual([(await cron(env, ok, T + 2 * H)).results, ok.calls.length], [[], 1]);
    assert.deepEqual(kv.rejected, []); noPii(ok);
    assert.equal(h, (await salesEventRecord("PURCHASE_APPROVED", "HP-D12-001", payload().data)).h, "[D12.5] mesmo hash de transação do registro de vendas");
  });
});

test("D12.6 estado final: aprovação + reembolso/chargeback/cancelamento (qualquer ordem) nunca é anunciada como aprovada; a vaga do teto não volta", async () => {
  for (const rev of ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED"]) for (const order of ["aprovacao_primeiro", "reversao_primeiro"]) {
    const env = hookEnv(), tg = telegram(503, 200);
    await withFetch(tg, async () => {
      const seqEv = order === "aprovacao_primeiro" ? ["PURCHASE_APPROVED", rev] : [rev, "PURCHASE_APPROVED"];
      for (const [i, e] of seqEv.entries()) assert.equal((await hook(env, payload({ event: e }), T + i * 60000)).status, 200, rev + " " + order);
      await cron(env, tg, T + H);
      const last = tg.calls[tg.calls.length - 1].text;
      assert.match(last, /pedido revertido/, `[D12.6] ${rev} ${order}`);
      assert.doesNotMatch(last, /pedido aprovado/, `[D12.6] ${rev} ${order}`);
      assert.match(last, /conta no teto do dia/);
      const n = tg.calls.length;
      await hook(env, payload({ txn: "HP-D12-009", at: T + 2 * H }), T + 2 * H);
      await cron(env, tg, T + 3 * H);
      assert.equal(tg.calls.length, n, "[D12.6] a reversão não devolve a vaga: 2º pedido do dia não avisa");
    });
  }
  // PIX gerado e expirado: revertido (expirado).
  const env = hookEnv(), tg = telegram(503, 200);
  await withFetch(tg, async () => {
    await hook(env, payload({ event: "PURCHASE_BILLET_PRINTED", dated: false }), T);
    await hook(env, payload({ event: "PURCHASE_EXPIRED", dated: false }), T + H);
    await cron(env, tg, T + 2 * H);
    assert.match(tg.calls.at(-1).text, /pedido revertido: expirado/);
  });
});

test("D12.7 busca pelo índice do dia: 3.000 eventos históricos no registro e 3.000 pedidos de dias anteriores não escondem o pedido", async () => {
  const env = hookEnv(), kv = env.ZEVANORY_PRIVATE_ARTIFACTS, tg = telegram(503);
  for (let i = 0; i < 3000; i++) {
    const key = SALES_EVENT_PREFIX + "00:" + String(i).padStart(32, "0") + ":approved:purchase_approved:" + "0".repeat(16);
    kv.m.set(key, "{}"); kv.meta.set(key, { event: "PURCHASE_APPROVED", facts: { at: new Date(T - 86400000 * (2 + (i % 300))).toISOString(), productId: "8704733" } });
    const d = new Date(T - 86400000 * (2 + (i % 400))).toISOString().slice(0, 10), hh = String(i).padStart(32, "a");
    kv.m.set(FIRST_ORDER_ALERT_PREFIX + d + ":candidato", hh);
    kv.m.set(FIRST_ORDER_ALERT_PREFIX + "txn:" + hh, JSON.stringify({ at: d + "T13:00:00.000Z", day: d, timeSource: "compra", product: "ia-na-pratica", event: "PURCHASE_APPROVED", liberado: true }));
  }
  await withFetch(tg, async () => { assert.equal((await hook(env, payload({ txn: "HP-D12-ZZZ" }))).status, 200); });
  const hz = await txnHash("HP-D12-ZZZ"), ledger = [...kv.m.keys()].filter((k) => k.startsWith(SALES_EVENT_PREFIX)).sort();
  assert.ok(ledger.findIndex((k) => k.includes(":" + hz + ":")) >= 3000, "[D12.7] o evento atual está além da 3ª página do registro de vendas");
  const ok = telegram(200);
  assert.deepEqual((await cron(env, ok, T + H)).results.map((r) => [r.day, r.alerted]), [["2026-11-20", true]], "[D12.7] encontrado além de 3 páginas de histórico");
  // Pedidos seguintes do mesmo dia não gravam nada (cota de gravações NC-989-02): só o 1º reivindica o dia.
  const env2 = hookEnv(), kv2 = env2.ZEVANORY_PRIVATE_ARTIFACTS;
  await withFetch(telegram(503), async () => { for (let i = 0; i < 20; i++) await hook(env2, payload({ txn: "HP-D12-N" + i, at: T + i * 60000 }), T + i * 60000); });
  assert.equal([...kv2.m.keys()].filter((k) => k.startsWith(FIRST_ORDER_ALERT_PREFIX + "txn:")).length, 1, "[D12.7] 20 pedidos no dia => 1 registro de candidato");
  assert.equal(kv2.m.get(FIRST_ORDER_ALERT_PREFIX + "2026-11-20:candidato"), await txnHash("HP-D12-N0"));
});

test("D12.8 evento sem data: hora de recepção registrada (origem explícita); virada BRT e reentrega não deslocam o pedido", async () => {
  const env = hookEnv(), kv = env.ZEVANORY_PRIVATE_ARTIFACTS, tg = telegram(503);
  const late = Date.parse("2026-11-21T02:50:00Z"); // 23:50 BRT do dia 20
  await withFetch(tg, async () => {
    assert.equal((await hook(env, payload({ dated: false }), late)).status, 200);
    assert.equal((await hook(env, payload({ dated: false }), late + 20 * 60000)).status, 200, "reentrega 00:10 BRT do dia 21");
  });
  const h = await txnHash("HP-D12-001"), rec = JSON.parse(kv.m.get(FIRST_ORDER_ALERT_PREFIX + "txn:" + h));
  assert.deepEqual([rec.day, rec.timeSource, rec.at], ["2026-11-20", "recepcao", new Date(late).toISOString()], "[D12.8] 1ª recepção registrada, não a reentrega");
  assert.equal(kv.m.has(FIRST_ORDER_ALERT_PREFIX + "2026-11-21:candidato"), false, "[D12.8] nada no dia 21");
  const ok = telegram(200);
  const r = await cron(env, ok, late + H); // 00:50 BRT do dia 21: recupera o de ontem
  assert.deepEqual(r.results.map((x) => [x.day, x.alerted]), [["2026-11-20", true]]);
  assert.match(ok.calls[0].text, /às 23:50 BRT \(hora de recepção do aviso da Hotmart; o payload veio sem data\)/);
  // Evento sem data JÁ no registro de vendas, sem registro do candidato (anterior ao D12/expirado): pendência, nunca "hoje".
  const env2 = hookEnv(), kv2 = env2.ZEVANORY_PRIVATE_ARTIFACTS;
  await withFetch(telegram(503), async () => { await hook(env2, payload({ txn: "HP-D12-OLD", dated: false }), T - 10 * 86400000); });
  for (const k of [...kv2.m.keys()]) if (k.startsWith(FIRST_ORDER_ALERT_PREFIX)) kv2.m.delete(k);
  resetHotmartSwitchCache();
  assert.deepEqual(await registerFirstOrderCandidate(env2, { event: "PURCHASE_APPROVED", data: payload({ txn: "HP-D12-OLD", dated: false }).data, now: T }), { ok: true, skipped: "sem_referencia_temporal", h: await txnHash("HP-D12-OLD") });
  await withFetch(telegram(200), async () => { assert.equal((await hook(env2, payload({ txn: "HP-D12-OLD", dated: false }), T)).status, 200); });
  assert.equal([...kv2.m.keys()].some((k) => k.endsWith(":candidato") || k.includes(":txn:")), false, "[D12.8] reentrega antiga não vira pedido de hoje");
  // Evento COM data antiga reentregue: não grava candidato e não avisa (dia antigo).
  const env3 = hookEnv(), tg3 = telegram(200);
  await withFetch(tg3, async () => { await hook(env3, payload({ txn: "HP-D12-OLD2", at: T - 5 * 86400000 }), T); });
  assert.deepEqual([tg3.calls.length, (await cron(env3, tg3, T + H)).results], [0, []], "[D12.8] evento datado antigo não avisa hoje");
  assert.equal([...env3.ZEVANORY_PRIVATE_ARTIFACTS.m.keys()].some((k) => k.startsWith(FIRST_ORDER_ALERT_PREFIX)), false, "[D12.8] e não grava nada (cota)");
});

test("D12.9 timeout incerto, segredo ausente, limite de tentativas e confirmação não gravada", async () => {
  const a = hookEnv(), ta = telegram("timeout");
  await withFetch(ta, async () => { await hook(a, payload()); });
  const oka = telegram(200);
  assert.equal((await cron(a, oka, T + H)).results[0].alerted, true, "[D12.9] incerto => reenvio (duplicata aceita)");
  const b = hookEnv({ secret: false }), tb = telegram(200);
  await withFetch(tb, async () => { await hook(b, payload()); });
  assert.equal(tb.calls.length, 0);
  b.TELEGRAM_ALERT = SECRET;
  assert.equal((await cron(b, tb, T + H)).results[0].alerted, true, "[D12.9] segredo configurado depois: cron avisa");
  const c = hookEnv(), tc = telegram(500);
  await withFetch(tc, async () => { await hook(c, payload()); });
  for (let i = 1; i <= MAX_ATTEMPTS + 2; i++) await cron(c, tc, T + i * H);
  assert.equal(tc.calls.length, MAX_ATTEMPTS, "[D12.9] no máximo MAX_ATTEMPTS envios no dia (em série)");
  const d = hookEnv(), kv = d.ZEVANORY_PRIVATE_ARTIFACTS, td = telegram(200);
  kv.fail((k) => k.endsWith(":enviado"), 2);
  await withFetch(td, async () => { await hook(d, payload()); });
  assert.equal((await cron(d, td, T + H)).results[0].alerted, true, "[D12.9] confirmação perdida => duplicata (preferida ao silêncio)");
  assert.deepEqual([a, b, c, d].flatMap((e) => e.ZEVANORY_PRIVATE_ARTIFACTS.rejected), []);
});

test("D12.10 concorrência: dois pedidos simultâneos => 1 a 2 avisos, nunca zero; depois nada", async () => {
  const env = hookEnv(), tg = telegram(200);
  await withFetch(tg, async () => { await Promise.all([hook(env, payload({ txn: "HP-D12-A" })), hook(env, payload({ txn: "HP-D12-B" }))]); });
  assert.ok(tg.calls.length >= 1 && tg.calls.length <= 2, "[D12.10] envios=" + tg.calls.length);
  assert.deepEqual((await cron(env, tg, T + H)).results, []);
});

test("D12.11 oferta autorizada: kit não liberado na recepção não avisa; retirado da lista depois do pedido ainda avisa", async () => {
  const a = hookEnv({ products: ["vendas-na-pratica"] }), ta = telegram(200);
  await withFetch(ta, async () => { await hook(a, payload()); });
  assert.deepEqual([ta.calls.length, (await cron(a, ta, T + H)).results], [0, []], "[D12.11] não liberado");
  const b = hookEnv(), tb = telegram(503);
  await withFetch(tb, async () => { await hook(b, payload()); });
  b.ZEVANORY_PRIVATE_ARTIFACTS.m.set(HOTMART_SALES_KEY, JSON.stringify(record({ products: ["vendas-na-pratica"] })));
  const ok = telegram(200);
  assert.equal((await cron(b, ok, T + H)).results[0].alerted, true, "[D12.11] autorização é a da recepção do pedido");
});

test("D12.12 o cron horário chama a recuperação do aviso", () => {
  const w = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  assert.match(w, /if\(controller\?\.cron==="0 \* \* \* \*"\)await retryFirstOrderAlert\(normalized\)/);
  const h = readTextNormalized(new URL("../worker/cp-nc012-digital-hotmart.mjs", import.meta.url));
  assert.ok(h.indexOf("registerFirstOrderCandidate(env") < h.indexOf("recordHotmartSale(kv"), "registro do candidato antes do registro de vendas");
});

test("D12.13 texto sem dado pessoal; avisos só para hoje/ontem BRT", async () => {
  const txt = firstOrderAlertText({ name: "IA na Prática", kind: "pedido aprovado", now: T });
  assert.match(txt, /1º pedido do dia do IA na Prática .* 10:00 BRT/);
  assert.doesNotMatch(txt, /@|HP-|R\$|\d{6,}/);
  assert.equal(brtDay(Date.parse("2026-11-20T02:30:00Z")), "2026-11-19");
  assert.equal(brtDay(Date.parse("2026-11-20T03:30:00Z")), "2026-11-20");
  assert.equal((await maybeAlertFirstOrder(hookEnv(), { day: "2026-11-10", now: T })).reason, "dia_antigo");
});
