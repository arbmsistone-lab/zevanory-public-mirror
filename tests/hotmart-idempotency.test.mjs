// L-1 (reauditoria do PR #946, rodada 3): postbacks idênticos SIMULTÂNEOS da Hotmart (mesma transação) enviam uma
// única mensagem de boas-vindas: a mensagem é a mesma (link do formulário derivado do segredo, da assinatura e da
// transação) e vai com a mesma Idempotency-Key, que o provedor (modelo do Resend: chave retida 24 h, 409 para payload
// diferente) entrega uma vez. Reproduz o cenário do auditor (tools/hotmart-replay.mjs: 3 postbacks simultâneos).
// Rótulos [HIn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { handleHotmartWebhook, handleBriefing, SERVICE_PRODUCT_NAME } from "../worker/content-service.mjs";

class SlowKV { data = new Map(); async get(k) { await new Promise((r) => setTimeout(r, 1)); return this.data.get(k) ?? null; } async put(k, v) { this.data.set(k, String(v)); } async delete(k) { this.data.delete(k); } async list({ prefix = "" } = {}) { return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } }
const HOTTOK = "hottok-test-1234567890abcdef";
// Modelo do Resend: a chave vale 24 h; mesma chave e mesmo conteúdo => 200 sem nova entrega; conteúdo diferente => 409.
function provider() {
  const keys = new Map(), delivered = [], calls = [], conflicts = [];
  let clock = 0;
  const fetchImpl = async (url, init) => {
    if (!String(url).includes("resend")) return new Response("{}", { status: 200 });
    const b = JSON.parse(init.body), k = init.headers["idempotency-key"] || "", sig = b.subject + "|" + b.text;
    calls.push({ to: b.to[0], key: k, subject: b.subject, text: b.text });
    if (k && keys.has(k) && clock - keys.get(k).at < 24) {
      if (keys.get(k).sig === sig) return new Response("{}", { status: 200 });
      conflicts.push(k);
      return new Response('{"name":"invalid_idempotent_request"}', { status: 409 });
    }
    if (k) keys.set(k, { sig, at: clock });
    delivered.push({ to: b.to[0], subject: b.subject, text: b.text, key: k });
    return new Response("{}", { status: 200 });
  };
  return { fetchImpl, delivered, calls, conflicts, tick: (h) => { clock += h; } };
}
const hook = (body) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK }, body: JSON.stringify(body) });
const purchase = (txn, sub = "SUB-" + txn) => ({ event: "PURCHASE_APPROVED", data: { product: { id: 999, name: SERVICE_PRODUCT_NAME }, buyer: { email: "cliente@example.com", name: "Maria Silva" }, purchase: { transaction: txn }, subscription: { subscriber: { code: sub } } } });
const welcomes = (pv) => pv.delivered.filter((m) => m.to === "cliente@example.com" && /Bem-vindo/.test(m.subject));

test("HI1 3 postbacks simultâneos da mesma transação: uma mensagem de boas-vindas entregue, mesma chave e mesmo conteúdo", async () => {
  const e = { ZEVANORY_PRIVATE_ARTIFACTS: new SlowKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_test", HOTMART_SERVICE_PRODUCT_IDS: "999" };
  const pv = provider();
  const out = await Promise.all([1, 2, 3].map(() => handleHotmartWebhook(hook(purchase("T2")), e, null, pv.fetchImpl)));
  assert.ok(out.every((r) => r.status === 200), "[HI1.1]");
  const welcome = pv.calls.filter((c) => c.to === "cliente@example.com");
  assert.ok(welcome.length >= 1 && welcome.every((c) => /^zevanory-cp-welcome-[0-9a-f]{32}$/.test(c.key)), "[HI1.2] toda chamada de boas-vindas leva a Idempotency-Key");
  assert.equal(new Set(welcome.map((c) => c.key)).size, 1, "[HI1.3] a mesma chave nas chamadas simultâneas");
  assert.equal(pv.delivered.filter((m) => m.to === "cliente@example.com").length, 1, "[HI1.4] uma única entrega");
  // O link continua funcionando: o token derivado aponta para o assinante.
  const link = /\/conteudo-pronto\/briefing\?t=([A-Za-z0-9_-]+)/.exec(pv.delivered.find((m) => m.to === "cliente@example.com").text)[1];
  const page = await handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + link), e, null, pv.fetchImpl);
  assert.equal(page.status, 200, "[HI1.5] formulário abre com o link entregue");
});

test("HI2 transações diferentes continuam recebendo cada uma a sua mensagem (a chave é por transação)", async () => {
  const e = { ZEVANORY_PRIVATE_ARTIFACTS: new SlowKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_test", HOTMART_SERVICE_PRODUCT_IDS: "999" };
  const pv = provider();
  await handleHotmartWebhook(hook(purchase("TA")), e, null, pv.fetchImpl);
  await handleHotmartWebhook(hook(purchase("TB")), e, null, pv.fetchImpl);
  assert.equal(pv.delivered.filter((m) => m.to === "cliente@example.com").length, 2, "[HI2.1]");
});

test("HI3 postbacks simultâneos montam a MESMA mensagem: nenhum 409 do provedor e texto idêntico em todas as chamadas", async () => {
  const e = { ZEVANORY_PRIVATE_ARTIFACTS: new SlowKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_test", HOTMART_SERVICE_PRODUCT_IDS: "999" };
  const pv = provider();
  await Promise.all([1, 2, 3, 4].map(() => handleHotmartWebhook(hook(purchase("T3")), e, null, pv.fetchImpl)));
  const calls = pv.calls.filter((c) => c.to === "cliente@example.com");
  assert.equal(new Set(calls.map((c) => c.text)).size, 1, "[HI3.1] o link do formulário é determinístico (mesmo texto)");
  assert.equal(pv.conflicts.length, 0, "[HI3.2] nenhum 409 (conteúdo diferente com a mesma chave)");
  assert.equal(welcomes(pv).length, 1, "[HI3.3]");
});

test("HI4 a chave é por TRANSAÇÃO: o mesmo assinante, numa renovação ainda sem formulário, recebe nova mensagem com chave nova", async () => {
  const e = { ZEVANORY_PRIVATE_ARTIFACTS: new SlowKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_test", HOTMART_SERVICE_PRODUCT_IDS: "999" };
  const pv = provider();
  await handleHotmartWebhook(hook(purchase("T4-A", "SUB-MESMO")), e, null, pv.fetchImpl);
  await handleHotmartWebhook(hook(purchase("T4-B", "SUB-MESMO")), e, null, pv.fetchImpl);
  const w = welcomes(pv);
  assert.equal(w.length, 2, "[HI4.1] uma mensagem por transação");
  assert.notEqual(w[0].key, w[1].key, "[HI4.2] chaves diferentes para transações diferentes do mesmo assinante");
});

test("HI5 marcador perdido e nova tentativa 25 h depois (fora da janela do provedor): a guarda briefingTxn impede a 2ª mensagem", async () => {
  const e = { ZEVANORY_PRIVATE_ARTIFACTS: new SlowKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_test", HOTMART_SERVICE_PRODUCT_IDS: "999" };
  const pv = provider();
  await handleHotmartWebhook(hook(purchase("T5")), e, null, pv.fetchImpl);
  for (const k of [...e.ZEVANORY_PRIVATE_ARTIFACTS.data.keys()]) if (k.startsWith("zpc:cp:txn:")) e.ZEVANORY_PRIVATE_ARTIFACTS.data.delete(k);
  pv.tick(25);
  const r = await handleHotmartWebhook(hook(purchase("T5")), e, null, pv.fetchImpl);
  assert.equal(r.status, 200, "[HI5.1]");
  assert.equal(welcomes(pv).length, 1, "[HI5.2] uma única mensagem de boas-vindas");
});
