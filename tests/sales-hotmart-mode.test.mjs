import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { readHotmartSwitch, resetHotmartSwitchCache, readSalesSwitch, resetSalesSwitchCache, handleSalesControl, HOTMART_SALES_KEY } from "../worker/sales-control.mjs";
import worker, { HOTMART_CHECKOUT, openSalesHtml } from "../worker/sales-public-worker.mjs";

// Roteiro v5.0, Nível 1 Hotmart-only: a frase do proprietário abre SOMENTE a compra pela Hotmart.
const AUTH = (extra = {}) => ({ enabled: true, authorization: "LIBERAR VENDAS", channel: "hotmart", by: "owner", at: new Date().toISOString(), ref: "https://github.com/arbmsistone-lab/zevanory-public-mirror/issues/1" , ...extra });
const kv = (map = {}) => ({ async get(k) { return map[k] ?? null; } });
const status = async (env) => (await handleSalesControl(new Request("https://zevanory.api.br/api/sales/hotmart-status"), env)).json();

test("canal Hotmart abre com o registro completo do proprietário, sem preflight do Mercado Pago", async () => {
  resetHotmartSwitchCache();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv({ [HOTMART_SALES_KEY]: JSON.stringify(AUTH()) }) };
  assert.equal((await readHotmartSwitch(env)).open, true);
  resetHotmartSwitchCache();
  const body = await status(env);
  assert.equal(body.open, true);
  assert.equal(body.channel, "hotmart");
  // O interruptor completo (checkout próprio, funil, blog) continua fechado.
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch(env)).enabled, false);
  resetSalesSwitchCache();
  resetHotmartSwitchCache();
});

test("canal Hotmart falha fechado: ausente, inválido, canal errado, registro incompleto ou só o interruptor completo", async () => {
  const green = JSON.stringify({ ok: true, at: new Date().toISOString(), checks: [] });
  const cases = [
    {}, { [HOTMART_SALES_KEY]: "garbage" }, { [HOTMART_SALES_KEY]: JSON.stringify(AUTH({ channel: undefined })) },
    { [HOTMART_SALES_KEY]: JSON.stringify(AUTH({ channel: "completo" })) }, { [HOTMART_SALES_KEY]: JSON.stringify(AUTH({ enabled: false })) },
    { [HOTMART_SALES_KEY]: JSON.stringify(AUTH({ authorization: "liberar vendas" })) }, { [HOTMART_SALES_KEY]: JSON.stringify(AUTH({ ref: "x" })) },
    { [HOTMART_SALES_KEY]: JSON.stringify(AUTH({ at: new Date(Date.now() + 3600e3).toISOString() })) },
    { "sales:open:v1": JSON.stringify(AUTH({ channel: undefined })), "zpc-sales-preflight:v1": green },
  ];
  for (const map of cases) {
    resetHotmartSwitchCache();
    assert.equal((await readHotmartSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv(map) })).open, false, JSON.stringify(map).slice(0, 120));
  }
  resetHotmartSwitchCache();
  assert.equal((await readHotmartSwitch({})).open, false);
  resetHotmartSwitchCache();
  assert.equal((await readHotmartSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: { async get() { throw new Error("kv down"); } } })).open, false);
  resetHotmartSwitchCache();
  const r = await handleSalesControl(new Request("https://zevanory.api.br/api/sales/hotmart-status", { method: "POST" }), {});
  assert.equal(r.status, 405);
});

// Site de vendas: CORE responde por rota (interruptor completo × canal Hotmart).
const ctx = { waitUntil() {} };
const page = (p) => { try { return readTextNormalized(fileURLToPath(new URL("../sales-public" + p, import.meta.url))); } catch { return null; } };
const env = ({ full = false, hotmart = false } = {}) => ({
  CORE: { fetch: async (u) => new Response(JSON.stringify({ open: String(u).includes("/api/sales/hotmart-status") ? hotmart : full }), { status: 200 }) },
  ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; const h = page(p); return h === null ? new Response("nf", { status: 404 }) : new Response(h, { status: 200, headers: { "content-type": "text/html" } }); } },
});
const get = (path, e, init = {}) => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": "Mozilla/5.0" }, ...init }), e, ctx);

test("modo Hotmart: /hotmart/<produto> leva ao checkout da Hotmart dos 5 produtos", async () => {
  for (const slug of Object.keys(HOTMART_CHECKOUT)) {
    const body = await (await get("/hotmart/" + slug, env({ hotmart: true }))).text();
    assert.match(body, /href="https:\/\/pay\.hotmart\.com\//, slug);
    assert.doesNotMatch(body, /Vendas pausadas/, slug);
  }
});

test("modo Hotmart: /comprar/<sku> GET redireciona para /hotmart; POST nunca cria checkout próprio", async () => {
  const r = await get("/comprar/ZEV-IA-011", env({ hotmart: true }), { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/hotmart/ia-na-pratica");
  const p = await get("/comprar/ZEV-IA-011", env({ hotmart: true }), { method: "POST" });
  assert.equal(p.status, 503);
});

test("modo Hotmart: página do produto mostra o botão de compra; Conteúdo Pronto e assinatura seguem fechados", async () => {
  const prod = await (await get("/ia-na-pratica", env({ hotmart: true }))).text();
  assert.match(prod, /href="\/comprar\/ZEV-IA-011"/);
  const cp = await get("/assinar/conteudo-pronto", env({ hotmart: true }), { redirect: "manual" });
  assert.equal(cp.headers.get("location"), null);
  assert.doesNotMatch(await cp.text(), /pay\.hotmart\.com/);
  const sub = '<a class="b" href="mailto:x" data-zev-sub="conteudo-pronto" data-zev-open-text="Assinar">Lista</a>';
  assert.doesNotMatch(openSalesHtml(sub, "solucoes", { subscriptions: false }), /\/assinar\//);
  assert.match(openSalesHtml(sub, "solucoes"), /\/assinar\/conteudo-pronto/);
});

test("tudo fechado (padrão): nenhum caminho leva à Hotmart", async () => {
  for (const slug of Object.keys(HOTMART_CHECKOUT)) {
    const body = await (await get("/hotmart/" + slug, env())).text();
    assert.match(body, /Vendas pausadas/, slug);
    assert.doesNotMatch(body, /pay\.hotmart\.com/, slug);
  }
  const prod = await (await get("/ia-na-pratica", env())).text();
  assert.doesNotMatch(prod, /href="\/comprar\//);
});

test("status do canal Hotmart inválido = fechado", async () => {
  for (const bad of [new Response("{}", { status: 200 }), new Response(JSON.stringify({ open: true }), { status: 500 }), new Response(JSON.stringify({ open: "true" }), { status: 200 })]) {
    const e = { CORE: { fetch: async (u) => String(u).includes("hotmart-status") ? bad.clone() : new Response(JSON.stringify({ open: false })) }, ASSETS: env().ASSETS };
    assert.match(await (await get("/hotmart/ia-na-pratica", e)).text(), /Vendas pausadas/);
  }
});
