import test from "node:test";
import assert from "node:assert/strict";
import { handleHotmartWebhook, handleBriefing, handlePackageView, retryPendingPackages, validatePosts, validateMessages, SERVICE_PRODUCT_NAME } from "../worker/content-service.mjs";

class MapKV { data = new Map(); async get(k) { return this.data.get(k) ?? null; } async put(k, v) { this.data.set(k, String(v)); } async delete(k) { this.data.delete(k); } async list({ prefix = "" } = {}) { return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } }
const HOTTOK = "hottok-test-1234567890abcdef";
const post = (i) => ({ tema: "Tema " + i, legenda: "Legenda completa e concreta para o negócio, explicando o benefício real do serviço sem promessas exageradas. ".repeat(3), cta: "Chame no WhatsApp", hashtags: ["#negocio", "#local"], imagem: "foto da equipe" });
const msg = (i) => ({ objetivo: "Objetivo " + i, texto: "Olá! Aqui é do negócio. Passando para lembrar da nossa oferta principal e tirar qualquer dúvida que você tenha." });
function fakeAI({ fail = false } = {}) {
  let calls = 0;
  return { calls: () => calls, run: async (_m, { messages }) => { calls++; if (fail) return { response: "sem json" }; const u = messages[1].content; return { response: JSON.stringify(u.includes("mensagens de WhatsApp") ? { mensagens: [1, 2, 3, 4].map(msg) } : { posts: [1, 2, 3, 4, 5, 6].map(post) }) }; } };
}
function env(extra = {}) { return { ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_test", AI: fakeAI(), ...extra }; }
const emails = [];
const fetchImpl = async (url, init) => { if (String(url).includes("resend")) { emails.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); } throw Error("unexpected " + url); };
const hook = (body, token = HOTTOK) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": token }, body: JSON.stringify(body) });
const purchase = (event, txn, extra = {}) => ({ event, data: { product: { id: 999, name: SERVICE_PRODUCT_NAME }, buyer: { email: "cliente@example.com", name: "Maria Silva" }, purchase: { transaction: txn }, subscription: { subscriber: { code: "SUB1" } }, ...extra } });

test("webhook rejects wrong hottok and missing config", async () => {
  const e = env();
  assert.equal((await handleHotmartWebhook(hook(purchase("PURCHASE_APPROVED", "T1"), "wrong"), e, null, fetchImpl)).status, 401);
  assert.equal((await handleHotmartWebhook(hook(purchase("PURCHASE_APPROVED", "T1")), { ...e, HOTMART_HOTTOK: "" }, null, fetchImpl)).status, 503);
});

test("full automatic flow: purchase -> briefing email -> form -> AI package -> delivery email -> renewal regenerates -> cancel stops", async () => {
  emails.length = 0;
  const e = env();
  const r1 = await handleHotmartWebhook(hook(purchase("PURCHASE_APPROVED", "T1")), e, null, fetchImpl);
  assert.equal((await r1.json()).status, "briefing_requested");
  const welcome = emails.find((m) => m.to[0] === "cliente@example.com");
  const link = welcome.text.match(/https:\/\/zevanory\.api\.br\/conteudo-pronto\/briefing\?t=([A-Za-z0-9_-]+)/);
  assert.ok(link, "briefing link sent");
  // duplicate postback is idempotent
  assert.equal((await (await handleHotmartWebhook(hook(purchase("PURCHASE_APPROVED", "T1")), e, null, fetchImpl)).json()).duplicate, true);
  const form = new URLSearchParams({ negocio: "Salão Bela", ramo: "salão de beleza", publico: "mulheres 25-50", produtos: "corte, escova, coloração", diferencial: "atendimento rápido", tom: "próximo", cidade: "Várzea Alegre" });
  const get = await handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + link[1]), e, null, fetchImpl);
  assert.equal(get.status, 200);
  const posted = await handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + link[1], { method: "POST", body: form }), e, null, fetchImpl);
  assert.equal(posted.status, 200);
  const delivery = emails.find((m) => /chegou/.test(m.subject));
  assert.ok(delivery, "package emailed");
  assert.match(delivery.text, /12 POSTS/);
  assert.equal((delivery.text.match(/^POST \d+/gm) || []).length, 12);
  assert.equal((delivery.text.match(/^MENSAGEM \d+/gm) || []).length, 4);
  const view = delivery.text.match(/pacote\?t=([A-Za-z0-9_-]+)/);
  const page = await handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + view[1]), e);
  assert.equal(page.status, 200);
  // renewal: new cycle generated automatically from stored briefing
  const before = emails.length;
  await handleHotmartWebhook(hook(purchase("PURCHASE_APPROVED", "T2")), e, null, fetchImpl);
  assert.ok(emails.slice(before).some((m) => /mês 2/.test(m.subject)), "renewal package delivered");
  // cancellation stops; old briefing link becomes invalid
  await handleHotmartWebhook(hook(purchase("SUBSCRIPTION_CANCELLATION", "T3")), e, null, fetchImpl);
  assert.equal((await handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + link[1]), e, null, fetchImpl)).status, 404);
  // logs/ledger never contain the buyer e-mail
  const ledger = [...e.ZEVANORY_PRIVATE_ARTIFACTS.data.entries()].filter(([k]) => k.startsWith("zpc-activity:")).map(([, v]) => v).join("");
  assert.doesNotMatch(ledger, /cliente@example\.com|Maria/);
});

test("AI failure schedules a retry instead of sending a bad package", async () => {
  emails.length = 0;
  const e = env({ AI: fakeAI({ fail: true }) });
  await handleHotmartWebhook(hook(purchase("PURCHASE_APPROVED", "T9")), e, null, fetchImpl);
  const t = emails[0].text.match(/t=([A-Za-z0-9_-]+)/)[1];
  await handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t, { method: "POST", body: new URLSearchParams({ negocio: "Loja X", ramo: "loja", publico: "todos", produtos: "roupas", diferencial: "preço", tom: "leve" }) }), e, null, fetchImpl);
  assert.ok(!emails.some((m) => /chegou/.test(m.subject)));
  assert.match(String(await e.ZEVANORY_PRIVATE_ARTIFACTS.get("zpc:cp:pending")), /zpc:cp:sub:/);
  e.AI = fakeAI();
  const out = await retryPendingPackages(e, fetchImpl);
  assert.equal(out.delivered, 1);
});

test("digital product postbacks only record visibility; validators reject promises", async () => {
  const e = env();
  const r = await handleHotmartWebhook(hook({ event: "PURCHASE_APPROVED", data: { product: { id: 8704733, name: "ZEVANORY IA na Prática" }, buyer: { email: "a@b.co" }, purchase: { transaction: "D1" } } }), e, null, fetchImpl);
  assert.equal((await r.json()).scope, "digital_product");
  assert.equal(validatePosts([{ ...post(1), legenda: "Resultado 100% garantido! ".repeat(10) }], 1), null);
  assert.equal(validateMessages([msg(1), msg(2), msg(3)]), null);
});
