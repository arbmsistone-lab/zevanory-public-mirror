import { test } from "node:test";
import assert from "node:assert/strict";
import { handleFunnel, buildFunnelSummary, isCountableView } from "../worker/funnel.mjs";
import { attribution, isFunnelPage } from "../worker/sales-public-worker.mjs";
import worker from "../worker/sales-public-worker.mjs";

const req = (u, h = {}) => new Request(u, { headers: h });
test("source comes from our utm tag, else from the referrer platform, else direct; labels are sanitized", () => {
  assert.deepEqual(attribution(req("https://v/x?utm_source=bluesky&utm_campaign=conteudo_20261012"), new URL("https://v/x?utm_source=bluesky&utm_campaign=conteudo_20261012")), { src: "bluesky", camp: "conteudo_20261012" });
  const g = "https://v/x"; assert.equal(attribution(req(g, { referer: "https://www.google.com.br/" }), new URL(g)).src, "google");
  assert.equal(attribution(req(g, { referer: "https://m.youtube.com/watch" }), new URL(g)).src, "youtube");
  assert.equal(attribution(req(g, { referer: "https://example.org/" }), new URL(g)).src, "outro");
  assert.equal(attribution(req(g), new URL(g)).src, "direto");
  const bad = "https://v/x?utm_source=%3Cscript%3E&utm_campaign=a%20b"; assert.deepEqual(attribution(req(bad), new URL(bad)), { src: "direto", camp: "" });
});
test("guides and calculators are measured like product pages", () => {
  assert.ok(isFunnelPage("ia-para-padaria") && isFunnelPage("calculadora-cmv") && isFunnelPage("ferramentas"));
  assert.ok(!isFunnelPage("termos"));
  const ua = "Mozilla/5.0 Chrome/130";
  assert.equal(isCountableView({ method: "GET", page: "calculadora-preco-de-venda", userAgent: ua }), true);
});
test("intent and source are stored as aggregate counters only and summarized per source", async () => {
  const calls = []; const factory = () => ({ query: async (t, p) => { calls.push({ t, p }); return t.includes("returning vhash") ? [{ vhash: "x" }] : []; } });
  const env = { DATABASE_URL: "x", RESEND_API_KEY: "s" };
  await handleFunnel(new Request("https://funnel.internal/hit", { method: "POST", body: JSON.stringify({ page: "lucro-e-caixa", metric: "checkout_intent", src: "bluesky", ua: "Mozilla/5.0 Chrome", ip: "198.51.100.7" }) }), env, { sqlFactory: factory });
  const metrics = calls.filter(c => c.p?.[2]).map(c => c.p[2]);
  assert.deepEqual(metrics, ["checkout_intent", "checkout_intent:src:bluesky"]);
  assert.doesNotMatch(JSON.stringify(calls), /198\.51\.100\.7/);
  const rows = [{ page: "ia-na-pratica", metric: "views", n: 10 }, { page: "ia-na-pratica", metric: "src:youtube", n: 6 }, { page: "ia-na-pratica", metric: "checkout_intent:src:youtube", n: 2 }, { page: "ia-na-pratica", metric: "camp:conteudo_20261012", n: 4 }];
  const s = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async t => (t.includes("group by page, metric") ? rows : []) }) });
  assert.deepEqual(s.sources.youtube, { views: 6, checkout_intent: 2, hotmart_view: 0, subscribe_click: 0 });
  assert.deepEqual(s.topCampaigns, [{ campaign: "conteudo_20261012", views: 4 }]);
  assert.equal(s.pages["ia-na-pratica"].views, 10);
});
test("subscribe redirect keeps the source for Hotmart's sale report", async () => {
  const r = await worker.fetch(new Request("https://vendas.zevanory.api.br/assinar/conteudo-pronto?utm_source=telegram"), {}, { waitUntil() {} });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^https:\/\/pay\.hotmart\.com\/X107980075B\?off=4ydutio7&src=telegram$/);
});
