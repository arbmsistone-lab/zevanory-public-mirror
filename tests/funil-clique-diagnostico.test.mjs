// Funil (contra-auditoria GPT-6, 15/11/2026): (1) acessos de teste com utm_source=diagnostico ficam em contadores
// próprios desde a gravação, sem tocar a contagem comercial; (2) "abriu a página da oferta" (hotmart_view) e
// "clicou para ir ao checkout" (hotmart_click, rota /hotmart/<produto>/ir) são eventos distintos; (3) o clique
// redireciona à oferta Hotmart cadastrada com a origem preservada, mesmo se a medição falhar.
import test from "node:test"; import assert from "node:assert/strict";
import worker, { handleHotmartClick, clickHref, HOTMART_CHECKOUT } from "../worker/sales-public-worker.mjs";
import { handleFunnel, buildFunnelSummary, METRIC_DEFINITIONS, INTENT_METRICS, DIAG_SOURCE } from "../worker/funnel.mjs";
import { readTextNormalized } from "./helpers/text.mjs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
// banco simulado: soma os bump() por (página, métrica)
function banco() { const n = new Map(); return { n, factory: () => ({ query: async (t, p) => { if (/insert into zevanory_funnel_daily/.test(t)) { const k = p[1] + "|" + (p[2] ?? (t.includes("'visitors'") ? "visitors" : "views")); n.set(k, (n.get(k) || 0) + 1); } return t.includes("returning vhash") ? [{ vhash: "x" }] : []; } }) }; }
// o CORE do worker de vendas entrega os hits ao handleFunnel (mesmo contrato do binding real)
function ambiente(db, { aberto = true, falhaMedicao = false } = {}) {
  const asset = readTextNormalized(new URL("../sales-public/lucro-e-caixa.html", import.meta.url));
  return { DATABASE_URL: "x", RESEND_API_KEY: "s", ASSETS: { fetch: async () => new Response(asset, { status: 200 }) },
    CORE: { fetch: async (u, init) => { const url = String(u?.url || u);
      if (/funnel\.internal\/hit/.test(url)) { if (falhaMedicao) throw new Error("core_fora"); return handleFunnel(new Request(url, init), { DATABASE_URL: "x", RESEND_API_KEY: "s" }, { sqlFactory: db.factory }); }
      return Response.json({ open: aberto }); } } };
}
const ctx = () => { const p = []; return { p, waitUntil: (x) => p.push(x), done: () => Promise.all(p) }; };
const req = (path) => new Request("https://vendas.zevanory.api.br" + path, { headers: { "user-agent": UA, "accept-language": "pt-BR", "cf-connecting-ip": "198.51.100.9" } });
const comerciais = (db) => [...db.n].filter(([k]) => !/\|diag:/.test(k));
const diag = (db, page, m) => db.n.get(page + "|diag:" + m) || 0;

test("teste controlado: chegada e clique com utm_source=diagnostico => +1 e +1 só nos contadores de diagnóstico; checkout correto; comercial intacto", async () => {
  const db = banco(), env = ambiente(db);
  let c = ctx(); const pag = await worker.fetch(req("/hotmart/lucro-e-caixa?utm_source=diagnostico"), env, c); await c.done();
  assert.equal(pag.status, 200);
  const html = await pag.text();
  assert.match(html, /href="\/hotmart\/lucro-e-caixa\/ir\?utm_source=diagnostico"/, "botão leva à rota de clique com a origem do teste");
  assert.equal(diag(db, "lucro-e-caixa", "hotmart_view"), 1, "+1 chegada (diagnóstico)");
  c = ctx(); const ir = await worker.fetch(req("/hotmart/lucro-e-caixa/ir?utm_source=diagnostico"), env, c); await c.done();
  assert.equal(ir.status, 302); assert.equal(ir.headers.get("location"), HOTMART_CHECKOUT["lucro-e-caixa"] + "&src=diagnostico", "oferta Hotmart cadastrada do produto");
  assert.equal(diag(db, "lucro-e-caixa", "hotmart_click"), 1, "+1 clique (diagnóstico)");
  assert.deepEqual(comerciais(db), [], "nenhum contador comercial alterado pelo teste");
});
test("visita comercial: chegada (hotmart_view) e clique (hotmart_click) são eventos distintos, com a origem", async () => {
  const db = banco(), env = ambiente(db);
  let c = ctx(); await (await worker.fetch(req("/hotmart/lucro-e-caixa?utm_source=youtube"), env, c)).text(); await c.done();
  assert.equal(db.n.get("lucro-e-caixa|hotmart_view"), 1); assert.equal(db.n.get("lucro-e-caixa|hotmart_view:src:youtube"), 1);
  assert.equal(db.n.get("lucro-e-caixa|hotmart_click") || 0, 0, "abrir a página não é clique");
  c = ctx(); const ir = await worker.fetch(req("/hotmart/lucro-e-caixa/ir?utm_source=youtube"), env, c); await c.done();
  assert.equal(ir.headers.get("location"), HOTMART_CHECKOUT["lucro-e-caixa"] + "&src=youtube");
  assert.equal(db.n.get("lucro-e-caixa|hotmart_click"), 1); assert.equal(db.n.get("lucro-e-caixa|hotmart_click:src:youtube"), 1);
  assert.equal(db.n.get("lucro-e-caixa|hotmart_view"), 1, "clique não soma chegada");
});
test("o checkout abre mesmo se a medição falhar; vendas pausadas não redirecionam; produto inexistente 404; HEAD não conta", async () => {
  const db = banco();
  let c = ctx(); const ir = await worker.fetch(req("/hotmart/lucro-e-caixa/ir?utm_source=youtube"), ambiente(db, { falhaMedicao: true }), c); await Promise.allSettled(c.p);
  assert.equal(ir.status, 302); assert.match(ir.headers.get("location"), /^https:\/\/pay\.hotmart\.com\/L107979973K\?off=ksb5di36&src=youtube$/);
  c = ctx(); const pausa = await worker.fetch(req("/hotmart/lucro-e-caixa/ir"), ambiente(db, { aberto: false }), c);
  assert.equal(pausa.status, 200); assert.equal(pausa.headers.get("location"), null); assert.match(await pausa.text(), /pausadas/);
  assert.equal((await handleHotmartClick(req("/hotmart/x/ir"), ambiente(db), "nao-existe", ctx())).status, 404);
  const db2 = banco(); c = ctx(); await worker.fetch(new Request("https://vendas.zevanory.api.br/hotmart/lucro-e-caixa/ir", { method: "HEAD", headers: { "user-agent": UA } }), ambiente(db2), c); await c.done();
  assert.equal(db2.n.size, 0, "HEAD não mede");
  assert.equal(clickHref("lucro-e-caixa", ""), "/hotmart/lucro-e-caixa/ir?utm_source=direto");
});
test("resumo: diagnóstico separado (clean.diagnostico), fora das origens, páginas e totais; rótulos das métricas", async () => {
  const rows = [{ page: "lucro-e-caixa", metric: "hotmart_view:src:youtube", n: 3 }, { page: "lucro-e-caixa", metric: "hotmart_click:src:youtube", n: 1 },
    { page: "lucro-e-caixa", metric: "diag:hotmart_view", n: 1 }, { page: "lucro-e-caixa", metric: "diag:hotmart_click", n: 1 }, { page: "lucro-e-caixa", metric: "views", n: 7 }];
  const s = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => (/group by page, metric/.test(t) ? rows : []) }) });
  assert.deepEqual(JSON.parse(JSON.stringify(s.clean.diagnostico)), { "lucro-e-caixa": { hotmart_view: 1, hotmart_click: 1 } });
  assert.equal(s.clean.sources.youtube.hotmart_view, 3); assert.equal(s.clean.sources.youtube.hotmart_click, 1);
  assert.equal(s.clean.sources.diagnostico, undefined); assert.equal(s.clean.pages["lucro-e-caixa"]["diag:hotmart_view"], undefined);
  assert.equal(DIAG_SOURCE, "diagnostico"); assert.ok(INTENT_METRICS.includes("hotmart_click"));
  assert.match(METRIC_DEFINITIONS.hotmart_view, /abriu a página da oferta/); assert.match(METRIC_DEFINITIONS.hotmart_click, /clicou para ir ao checkout/);
});
// GPT-6 (15/11, NO-GO 0825b3f5): o painel lê snapshot.funnel (KV zpc:command:v1:snapshot), não o log do Actions.
// Este teste roda o resumo do worker → KV simulado → main() do snapshot e confere o objeto GRAVADO que o painel recebe.
test("painel recebe: snapshot.funnel.oferta com os dois indicadores rotulados e o diagnóstico à parte (saída gravada no KV)", async () => {
  // 31 origens: a de menor volume (fora do corte das 30 maiores) tem 1 clique, que precisa entrar no total
  const rows = [{ page: "lucro-e-caixa", metric: "hotmart_view:src:youtube", n: 3 }, { page: "lucro-e-caixa", metric: "hotmart_click:src:youtube", n: 1 },
    { page: "lucro-e-caixa", metric: "diag:hotmart_view", n: 1 }, { page: "lucro-e-caixa", metric: "diag:hotmart_click", n: 1 }, { page: "lucro-e-caixa", metric: "views", n: 7 }];
  for (let i = 0; i < 30; i++) rows.push({ page: "lucro-e-caixa", metric: "src:camp" + i, n: 50 });
  rows.push({ page: "lucro-e-caixa", metric: "src:rara", n: 1 }, { page: "lucro-e-caixa", metric: "hotmart_click:src:rara", n: 1 });
  const resumo = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => (/group by page, metric/.test(t) ? rows : []) }) });
  assert.equal(resumo.clean.sources.rara, undefined, "premissa: a origem rara saiu do corte");
  assert.deepEqual(resumo.clean.oferta, { hotmart_view: 3, hotmart_click: 2 });
  resumo.generatedAt = new Date().toISOString();
  const store = new Map([["zpc-funnel:v1:summary", JSON.stringify(resumo)]]);
  const realFetch = globalThis.fetch, realLog = console.log, logs = [];
  globalThis.fetch = async (u, o = {}) => {
    u = String(u); const res = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (u.includes("/storage/kv/")) {
      if (u.includes("/keys?")) return res(200, { result: [] });
      const k = decodeURIComponent(u.match(/values\/([^?]+)/)[1]);
      if ((o.method || "GET") === "PUT") { store.set(k, o.body); return res(200, {}); }
      return store.has(k) ? res(200, store.get(k)) : res(404, "");
    }
    if (u.includes("oauth2") || u.includes("token")) return res(200, { access_token: "x", expires_in: 3600 });
    return res(200, {});
  };
  console.log = (...a) => { logs.push(a.join(" ")); };
  Object.assign(process.env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", KV_NAMESPACE_ID: "n" });
  try {
    const { main, SNAPSHOT_KEY, ROTULOS_OFERTA } = await import("../scripts/audit/command-center-snapshot.mjs");
    await main();
    const of = JSON.parse(store.get(SNAPSHOT_KEY)).funnel.oferta;
    assert.equal(ROTULOS_OFERTA.hotmart_view, "Abriu a página da oferta"); assert.equal(ROTULOS_OFERTA.hotmart_click, "Clicou para ir ao checkout");
    assert.equal(of.abriuOferta.value, 3); assert.match(of.abriuOferta.definition, /^Abriu a página da oferta/); assert.equal(of.abriuOferta.integrity, "aggregated");
    assert.equal(of.clicouCheckout.value, 2); assert.match(of.clicouCheckout.definition, /^Clicou para ir ao checkout/);
    assert.deepEqual(of.diagnostico, { abriuOferta: 1, clicouCheckout: 1 }, "diagnóstico à parte, fora dos números comerciais");
    assert.equal(of.since, resumo.clean.since);
    const hv = logs.find((l) => l.includes("title=HOTMART_VIEW::")); assert.match(hv, /"hotmart_view":3,"hotmart_click":2/, "aviso público = mesmo total do painel");
    // sem resumo do funil: nunca um número
    store.delete("zpc-funnel:v1:summary"); store.delete(SNAPSHOT_KEY); await main();
    const vazio = JSON.parse(store.get(SNAPSHOT_KEY)).funnel.oferta;
    assert.equal(vazio.abriuOferta.value, null); assert.equal(vazio.abriuOferta.integrity, "missing"); assert.equal(vazio.clicouCheckout.integrity, "missing");
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});
