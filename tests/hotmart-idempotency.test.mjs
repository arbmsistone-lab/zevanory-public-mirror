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
function provider() {
  const keys = new Map(), delivered = [], calls = [];
  const fetchImpl = async (url, init) => {
    if (!String(url).includes("resend")) return new Response("{}", { status: 200 });
    const b = JSON.parse(init.body), k = init.headers["idempotency-key"] || "", sig = b.subject + "|" + b.text;
    calls.push({ to: b.to[0], key: k, subject: b.subject });
    if (k && keys.has(k)) return keys.get(k) === sig ? new Response("{}", { status: 200 }) : new Response('{"name":"invalid_idempotent_request"}', { status: 409 });
    if (k) keys.set(k, sig);
    delivered.push({ to: b.to[0], subject: b.subject, text: b.text });
    return new Response("{}", { status: 200 });
  };
  return { fetchImpl, delivered, calls };
}
const hook = (body) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK }, body: JSON.stringify(body) });
const purchase = (txn) => ({ event: "PURCHASE_APPROVED", data: { product: { id: 999, name: SERVICE_PRODUCT_NAME }, buyer: { email: "cliente@example.com", name: "Maria Silva" }, purchase: { transaction: txn }, subscription: { subscriber: { code: "SUB-" + txn } } } });

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
