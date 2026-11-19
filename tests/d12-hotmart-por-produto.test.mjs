import test from "node:test";
import assert from "node:assert/strict";
import { readHotmartSwitch, resetHotmartSwitchCache, handleSalesControl, HOTMART_SALES_KEY, hotmartRecordProducts, hotmartProductOpen, HOTMART_PRODUCT_SLUGS } from "../worker/sales-control.mjs";
import { hotmartKitsOpen, purchaseOpenFor } from "../worker/sales-lock-content.mjs";
import { maybeAlertFirstOrder, brtDay, firstOrderAlertText, FIRST_ORDER_ALERT_PREFIX, MAX_ATTEMPTS } from "../worker/hotmart-first-order-alert.mjs";
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
  assert.deepEqual([...env.ZEVANORY_PRIVATE_ARTIFACTS.m.keys()].filter((k) => k.startsWith(FIRST_ORDER_ALERT_PREFIX)).sort(), [FIRST_ORDER_ALERT_PREFIX + "2026-11-19", FIRST_ORDER_ALERT_PREFIX + "2026-11-20"]);
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

// Contra-auditoria GPT-6 (f57e8cf8): só o envio CONFIRMADO suprime o dia; falha, timeout e segredo ausente não.
const seq = (...outcomes) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); const o = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]; if (o === "timeout") throw new DOMException("timeout", "TimeoutError"); return new Response("{}", { status: o }); } }; };
const ev = (env, t, n) => maybeAlertFirstOrder(env, { event: "PURCHASE_APPROVED", productId: "8704733", recorded: true, now: T + n * 60000, fetchImpl: t.fetchImpl });
const markOf = (env) => JSON.parse(env.ZEVANORY_PRIVATE_ARTIFACTS.m.get(FIRST_ORDER_ALERT_PREFIX + "2026-11-20"));

test("D12.8 recuperação: 503 → próximo evento envia; timeout incerto → próximo evento reenvia; segredo ausente não grava", async () => {
  resetHotmartSwitchCache();
  const e1 = alertEnv(), t1 = seq(503, 200);
  assert.deepEqual([(await ev(e1, t1, 0)).reason, markOf(e1).status], ["telegram_503", "falhou"], "[D12.8] 1ª tentativa falha");
  assert.deepEqual([(await ev(e1, t1, 1)).alerted, markOf(e1).status, t1.calls.length], [true, "enviado", 2], "[D12.8] evento seguinte recupera");
  assert.deepEqual([(await ev(e1, t1, 2)).reason, t1.calls.length], ["ja_avisado_hoje", 2], "[D12.8] depois do envio confirmado, nada");
  const e2 = alertEnv(), t2 = seq("timeout", 200);
  assert.deepEqual([(await ev(e2, t2, 0)).reason, markOf(e2).status], ["telegram_incerto", "incerto"], "[D12.8] timeout = incerto");
  assert.deepEqual([(await ev(e2, t2, 1)).alerted, t2.calls.length], [true, 2], "[D12.8] incerto não suprime (duplicata aceita)");
  const e3 = envWith(record()), t3 = seq(200);
  assert.equal((await ev(e3, t3, 0)).reason, "telegram_nao_configurado");
  assert.equal(e3.ZEVANORY_PRIVATE_ARTIFACTS.m.has(FIRST_ORDER_ALERT_PREFIX + "2026-11-20"), false, "[D12.8] sem segredo, sem marca");
  e3.TELEGRAM_ALERT = alertEnv().TELEGRAM_ALERT;
  assert.equal((await ev(e3, t3, 1)).alerted, true, "[D12.8] segredo configurado depois ainda avisa no mesmo dia");
  const e4 = alertEnv(), t4 = seq(500);
  for (let i = 0; i < MAX_ATTEMPTS; i++) await ev(e4, t4, i);
  assert.deepEqual([(await ev(e4, t4, 9)).reason, t4.calls.length], ["tentativas_esgotadas", MAX_ATTEMPTS], "[D12.8] limite diário de tentativas");
  const e5 = alertEnv(), t5 = seq(200);
  e5.ZEVANORY_PRIVATE_ARTIFACTS.m.set(FIRST_ORDER_ALERT_PREFIX + "2026-11-20", JSON.stringify({ status: "tentando", attempts: 1 }));
  assert.equal((await ev(e5, t5, 0)).alerted, true, "[D12.8] 'tentando' (gravação final perdida) não suprime");
  resetHotmartSwitchCache();
});

test("D12.9 eventos concorrentes: pelo menos 1 e no máximo 2 avisos (KV sem compare-and-set; nunca zero)", async () => {
  resetHotmartSwitchCache();
  const env = alertEnv(), t = seq(200);
  const rs = await Promise.all([ev(env, t, 0), ev(env, t, 0)]);
  assert.ok(t.calls.length >= 1 && t.calls.length <= 2, "[D12.9] envios=" + t.calls.length);
  assert.ok(rs.some((r) => r.alerted), "[D12.9] ao menos um confirmado");
  assert.equal(markOf(env).status, "enviado");
  assert.equal((await ev(env, t, 1)).reason, "ja_avisado_hoje");
  resetHotmartSwitchCache();
});
