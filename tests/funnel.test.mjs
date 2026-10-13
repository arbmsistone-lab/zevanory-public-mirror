import { test } from "node:test";
import assert from "node:assert/strict";
import { isCountableView, handleFunnel, buildFunnelSummary } from "../worker/funnel.mjs";

function fakeSql(responder) {
  const calls = [];
  return { calls, factory: () => ({ query: async (text, params) => { calls.push({ text, params }); return responder(text, params); } }) };
}

test("counts only human GET views of tracked pages", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/130";
  assert.equal(isCountableView({ method: "GET", page: "ia-na-pratica", userAgent: ua }), true);
  assert.equal(isCountableView({ method: "GET", page: "termos", userAgent: ua }), false);
  assert.equal(isCountableView({ method: "GET", page: "ia-na-pratica", userAgent: "facebookexternalhit/1.1" }), false);
  assert.equal(isCountableView({ method: "GET", page: "ia-na-pratica", userAgent: "" }), false);
  assert.equal(isCountableView({ method: "GET", page: "ia-na-pratica", userAgent: ua, purpose: "prefetch" }), false);
});

test("public hosts cannot reach the counter; internal host stores hashed visitors only", async () => {
  const { calls, factory } = fakeSql((text) => (text.includes("returning vhash") ? [{ vhash: "x" }] : []));
  const env = { DATABASE_URL: "postgres://x", RESEND_API_KEY: "salt" };
  assert.equal(await handleFunnel(new Request("https://zevanory.api.br/hit", { method: "POST" }), env, { sqlFactory: factory }), null);
  const res = await handleFunnel(new Request("https://funnel.internal/hit", { method: "POST", body: JSON.stringify({ page: "lucro-e-caixa", ua: "Mozilla/5.0 Chrome", ip: "203.0.113.9" }) }), env, { sqlFactory: factory });
  assert.equal(res.status, 204);
  const stored = JSON.stringify(calls.map((c) => c.params));
  assert.doesNotMatch(stored, /203\.0\.113\.9/, "raw IP never stored");
  assert.ok(calls.some((c) => /'visitors'/.test(c.text)), "unique visitor counted");
});

test("test-mode sales never mix sandbox orders into the funnel", async () => {
  const { calls, factory } = fakeSql((text) => (text.includes("zevanory_funnel_daily where") || text.includes("from zevanory_funnel_daily") ? [{ page: "ia-na-pratica", metric: "views", n: 40 }, { page: "ia-na-pratica", metric: "visitors", n: 30 }] : []));
  const summary = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: factory });
  assert.equal(summary.salesMode, "test");
  assert.equal(summary.products["ia-na-pratica"].visitors, 30);
  assert.equal(summary.products["ia-na-pratica"].paid, 0);
  assert.ok(!calls.some((c) => /from orders/.test(c.text)), "orders not queried in test mode");
});

test("clean breakdown counts only days after the bot filter, split by page, source and campaign", async () => {
  const seen = [];
  const rows = [
    { page: "ia-na-pratica", metric: "views", n: 7 }, { page: "ia-na-pratica", metric: "src:youtube", n: 5 },
    { page: "ia-na-pratica", metric: "checkout_intent:src:youtube", n: 1 }, { page: "ia-na-pratica", metric: "camp:calc_20261012", n: 3 },
  ];
  const s = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t, p) => { seen.push({ t, p }); return t.includes("day >= $1::date group by page, metric") ? rows : []; } }) });
  assert.ok(seen.some((c) => c.t.includes("day >= $1::date group by page, metric") && c.p[0] === "2026-10-12"));
  assert.equal(s.clean.since, "2026-10-12");
  assert.deepEqual(s.clean.pages["ia-na-pratica"], { views: 7 });
  assert.deepEqual(s.clean.sources.youtube, { views: 5, checkout_intent: 1, hotmart_view: 0, subscribe_click: 0 });
  assert.deepEqual(s.clean.campaigns, { calc_20261012: 3 });
});
