// C1 (18/11/2026): lista fechada dos 5 kits ANTES do registro financeiro no webhook Hotmart (worker/cp-nc012-digital-
// hotmart.mjs). Produto fora da lista (Zevanory Gestão 8709787, ID desconhecido, ID ausente) responde 200 ignorado e
// não grava NADA: venda, atividade (delivery_sent / refund_requested), diário ou pós-venda. Os 5 kits seguem como hoje.
// KV, Hotmart e e-mail falsos; nenhum segredo real, nenhuma rede.
import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "../worker/cp-nc012-digital-hotmart.mjs";
import { killedMutation } from "./helpers/f1-mutation.mjs";

const source = new URL("../worker/cp-nc012-digital-hotmart.mjs", import.meta.url);
const T = Date.parse("2026-11-18T15:00:00Z");
const TOKEN = "synthetic-hotmart-hottok-c1";
const KITS = ["8704733", "8704826", "8704851", "8704861", "8704871"];
const GESTAO = "8709787";
const ACTIVE = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE"];
const STOP = ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED", "PURCHASE_PROTEST", "SUBSCRIPTION_CANCELLATION"];
const OTHER = ["PURCHASE_EXPIRED", "PURCHASE_DELAYED", "PURCHASE_BILLET_PRINTED"];

function fixture({ failPut = false } = {}) {
  const data = new Map();
  const ops = [];
  const kv = {
    async get(k) { ops.push("get " + k); return data.get(k) ?? null; },
    async put(k, v) { ops.push("put " + k); if (failPut) throw new Error("kv down"); data.set(k, String(v)); },
    async delete(k) { ops.push("delete " + k); data.delete(k); },
    async list({ prefix = "" } = {}) { ops.push("list " + prefix); return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
  return { data, ops, env: { ZEVANORY_PRIVATE_ARTIFACTS: kv, HOTMART_HOTTOK: TOKEN } };
}
function body(productId, event = "PURCHASE_APPROVED", txn = "HP-C1-0001") {
  const product = productId === undefined ? {} : { id: productId };
  return { version: "2.0.0", event, data: { product, purchase: { transaction: txn, approved_date: T }, buyer: { email: "comprador@example.test", name: "Pessoa Teste" } } };
}
async function send(m, f, b, token = TOKEN) {
  const res = await m.handleDigitalHotmartNc012(new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": token }, body: JSON.stringify(b) }), f.env, { now: T });
  return { status: res.status, json: await res.json() };
}
const writes = (f) => f.ops.filter((o) => /^(put|delete) /.test(o));

// Cenário central: produto fora da lista com cada evento relevante = 200 ignorado e zero acesso ao KV.
async function foraDaLista(m) {
  for (const id of [GESTAO, 123456, "999", "", undefined, "8704905x"]) {
    for (const event of [...ACTIVE, ...STOP, ...OTHER]) {
      const f = fixture();
      const r = await send(m, f, body(id, event));
      assert.equal(r.status, 200, `${id} ${event}`);
      assert.deepEqual(r.json, { ok: true, ignored: true, scope: "produto_fora_da_lista" }, `${id} ${event}`);
      assert.deepEqual(f.ops, [], `nenhum acesso ao KV: ${id} ${event}`);
    }
  }
}
// Os 5 kits continuam registrando como hoje: venda + atividade (entrega ou reembolso).
async function kitsRegistram(m) {
  for (const id of KITS) {
    for (const event of [...ACTIVE, ...STOP]) {
      const f = fixture();
      const r = await send(m, f, body(Number(id), event, "HP-C1-" + id + "-" + event));
      assert.equal(r.status, 200, `${id} ${event}`);
      assert.equal(r.json.scope, "digital_product");
      assert.ok([...f.data.keys()].some((k) => k.startsWith("zpc:sales:v1:ev:")), `venda registrada ${id} ${event}`);
      const kind = ACTIVE.includes(event) ? "delivery_sent" : "refund_requested";
      assert.ok([...f.data.values()].some((v) => v.includes(kind)), `atividade ${kind} ${id} ${event}`);
    }
  }
}

test("C1: a lista fechada vem de data/p18-commercial-allowlist.json e tem exatamente os 5 kits (sem Gestão nem Conteúdo Pronto)", () => {
  assert.deepEqual([...mod.KIT_PRODUCT_IDS].sort(), [...KITS].sort());
  assert.equal(mod.KIT_PRODUCT_IDS.includes(GESTAO), false);
  assert.equal(mod.KIT_PRODUCT_IDS.includes("8704905"), false);
});
test("C1: Gestão 8709787, ID desconhecido, inválido ou ausente = 200 ignorado, sem nenhuma leitura ou gravação, em todos os eventos", () => foraDaLista(mod));
test("C1: os 5 kits × (aprovada, completa, reembolsada, chargeback, cancelada, protesto, cancelamento de assinatura) registram como antes", () => kitsRegistram(mod));
test("C1: hottok inválido com produto fora da lista continua 401 (autenticação antes da lista)", async () => {
  const f = fixture();
  const r = await send(mod, f, body(GESTAO), "hottok-errado-mas-com-tamanho");
  assert.equal(r.status, 401);
  assert.deepEqual(f.ops, []);
});
test("C1: Conteúdo Pronto continua desviado (403 cp_event_misrouted), sem tocar no KV", async () => {
  const f = fixture();
  const r = await send(mod, f, body(8704905));
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "cp_event_misrouted");
  assert.deepEqual(f.ops, []);
});
test("C1: falha de KV com kit = 503 (a Hotmart reenvia); com produto fora da lista = 200 sem tocar no KV", async () => {
  const k = fixture({ failPut: true });
  assert.equal((await send(mod, k, body(8704733))).status, 503);
  const g = fixture({ failPut: true });
  const r = await send(mod, g, body(GESTAO));
  assert.equal(r.status, 200);
  assert.deepEqual(g.ops, []);
});
test("C1: duplicata de kit continua idempotente (uma venda, resposta duplicate)", async () => {
  const f = fixture();
  assert.equal((await send(mod, f, body(8704851))).json.duplicate, false);
  const n = [...f.data.keys()].filter((k) => k.startsWith("zpc:sales:v1:ev:")).length;
  assert.equal((await send(mod, f, body(8704851))).json.duplicate, true);
  assert.equal([...f.data.keys()].filter((k) => k.startsWith("zpc:sales:v1:ev:")).length, n);
});
test("C1: o log do produto ignorado tem só o ID numérico e o evento (nada do comprador nem da transação)", async () => {
  const logs = [];
  const old = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try { await send(mod, fixture(), body(GESTAO)); } finally { console.log = old; }
  const line = logs.find((l) => l.includes("hotmart_produto_fora_da_lista"));
  assert.ok(line);
  assert.deepEqual(JSON.parse(line), { evt: "hotmart_produto_fora_da_lista", product_id: GESTAO, event: "PURCHASE_APPROVED" });
  assert.equal(logs.some((l) => l.includes("comprador@example.test") || l.includes("HP-C1-0001")), false);
});

// Mutantes: cada um tem de morrer pelo cenário indicado.
test("C1 mutante: sem a checagem da lista (produto de fora registra venda)", async () => {
  await killedMutation(source, [["if(!KIT_PRODUCT_IDS.includes(productId)){", "if(false){"]], foraDaLista);
});
test("C1 mutante: checagem depois da gravação (produto de fora toca no KV)", async () => {
  await killedMutation(source, [
    [" if(!KIT_PRODUCT_IDS.includes(productId)){\n", " if(false){\n"],
    [" await enqueueHotmartPostSaleSecondary(request,env,body,{now});", " if(!KIT_PRODUCT_IDS.includes(productId))return json(200,{ok:true,ignored:true,scope:\"produto_fora_da_lista\"});\n await enqueueHotmartPostSaleSecondary(request,env,body,{now});"],
  ], foraDaLista);
});
test("C1 mutante: produto de fora responde 4xx (a Hotmart ficaria reenviando)", async () => {
  await killedMutation(source, [["return json(200,{ok:true,ignored:true,scope:\"produto_fora_da_lista\"});", "return json(422,{ok:false,ignored:true,scope:\"produto_fora_da_lista\"});"]], foraDaLista);
});
test("C1 mutante: Gestão incluída na lista (kind ignorado)", async () => {
  await killedMutation(source, [["ALLOW.products.filter(p=>p.kind===\"kit\")", "ALLOW.products"]], async (m) => {
    assert.equal(m.KIT_PRODUCT_IDS.includes("8704905"), false);
    await foraDaLista(m);
  });
});
test("C1 mutante: kit deixa de registrar (lista vazia)", async () => {
  await killedMutation(source, [["ALLOW.products.filter(p=>p.kind===\"kit\")", "ALLOW.products.filter(p=>p.kind===\"nenhum\")"]], kitsRegistram);
});

// Orçamento do PÓS-VENDA (decisão do titular de 18/11, opção B: registro ≤ 500/dia; pós-venda com orçamento separado
// que inclui recuperação e envios). Contagem EXATA das gravações em zpc:posvenda:hotmart:* por venda de kit:
//   entrega normal: 1 (pedido) | recuperação: +1 na entrega que falha (falha) e +2 na reentrega (pedido + limpeza da
//   falha) | envios do ciclo d0/d1/d5: 3 por etapa = 9 por pedido | status: por execução do envio, não por venda.
test("C1: orçamento do pós-venda medido por venda (entrega, recuperação e envios) é o declarado", async () => {
  const pv = await import("../worker/hotmart-post-sale.mjs");
  const BASE = "zpc:posvenda:hotmart:", DAY = 86400000;
  function fx() {
    const data = new Map(), writes = [], emails = []; let failure = null, clock = T;
    data.set("sales:hotmart:v1", JSON.stringify({ channel: "hotmart", enabled: true, authorization: "LIBERAR VENDAS", by: "fixture", ref: "fixture/purchase", at: new Date(T - 1000).toISOString() }));
    const kv = { get: async (k) => { if (k === failure) throw Error("ilegivel"); return data.get(k) ?? null; }, put: async (k, v) => { writes.push(k); data.set(k, v); },
      list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
    const fetchImpl = async (url, req = {}) => {
      if (req.method === "POST") { const m = JSON.parse(req.body); const row = { ...m, id: "mail-" + (emails.length + 1), created_at: new Date(clock).toISOString() }; emails.push(row); return { status: 200, json: async () => ({ id: row.id }) }; }
      if (String(url).endsWith("/usage")) return { status: 200, json: async () => ({ object: "usage", emails: { daily: { used: 0, limit: 100, resets_at: new Date(clock + DAY).toISOString() }, monthly: { used: emails.length, limit: 3000, resets_at: new Date(clock + 31 * DAY).toISOString() } } }) };
      if (String(url).includes("/emails?")) return { status: 200, json: async () => ({ data: emails, has_more: false }) };
      return { status: 200, json: async () => emails.find((x) => url.endsWith("/" + x.id)) };
    };
    return { writes, env: { ZEVANORY_PRIVATE_ARTIFACTS: kv, HOTMART_HOTTOK: TOKEN, RESEND_API_KEY: "synthetic" }, fetchImpl, fail: (k) => { failure = k; }, setNow: (n) => { clock = n; } };
  }
  const post = (s) => send(mod, s, body(8704733, "PURCHASE_APPROVED", "HP-ORC-1"));
  const only = (w) => w.filter((k) => k.startsWith(BASE));
  const kind = (k) => k.slice(BASE.length).split(":")[0];
  const count = (w) => only(w).reduce((m, k) => ((m[kind(k)] = (m[kind(k)] || 0) + 1), m), {});
  // 1) entrega normal
  const a = fx(); await post(a);
  assert.deepEqual(count(a.writes), { pedido: 1 }, "entrega normal: 1 gravação");
  // 2) recuperação: a 1ª entrega falha no pós-venda (a venda continua registrada), a reentrega conclui
  const r = fx();
  const ref = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("HP-ORC-1")))].map((x) => x.toString(16).padStart(2, "0")).join("");
  r.fail(BASE + "pedido:" + ref);
  const old = console.error; console.error = () => {};
  try { assert.equal((await post(r)).status, 200); } finally { console.error = old; }
  assert.deepEqual(count(r.writes), { falha: 1 }, "entrega que falha: 1 gravação (marcador de falha)");
  r.fail(null);
  const n0 = r.writes.length; await post(r);
  assert.deepEqual(count(r.writes.slice(n0)), { pedido: 1, falha: 1 }, "reentrega: 2 gravações (pedido + limpeza da falha)");
  // 3) envios: ciclo completo d0/d1/d5 de UM pedido
  const e = fx(); await post(e);
  const e0 = e.writes.length;
  for (const now of [T, T + DAY, T + 5 * DAY, T + 6 * DAY]) { e.setNow(now); await pv.runHotmartPostSale(e.env, { now, fetchImpl: e.fetchImpl }); }
  const envios = count(e.writes.slice(e0));
  assert.equal(envios["HP-ORC-1"], 9, "envios: 3 gravações por etapa × 3 etapas = 9 por pedido");
  assert.ok((envios.status || 0) <= 4, "status: no máximo 1 por execução do envio (4 execuções)");
  assert.deepEqual(Object.keys(envios).sort(), ["HP-ORC-1", "status"].filter((k) => envios[k]).sort());
});
