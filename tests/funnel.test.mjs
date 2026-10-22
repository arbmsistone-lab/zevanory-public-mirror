import { test } from "node:test";
import assert from "node:assert/strict";
import { isCountableView, handleFunnel, buildFunnelSummary, trafficClass } from "../worker/funnel.mjs";

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

test("versioned funnel events are validated and stored without a raw IP", async () => {
  const { calls, factory } = fakeSql((text, params) => {
    if (text.includes("insert into zevanory_funnel_events")) return [{ event_id: params[0] }];
    return [];
  });
  const event = {
    event_id: "00000000-0000-4000-8000-000000000042",
    version: "1.0.0",
    name: "visit",
    occurred_at: "2026-10-22T12:00:00.000Z",
    page: "ia-na-pratica",
  };
  const env = { DATABASE_URL: "postgres://x", MERCADOPAGO_ENV: "sandbox" };
  const request = (value) => new Request("https://funnel.internal/event", {
    method: "POST",
    body: JSON.stringify({ event: value, ua: "Mozilla/5.0 Chrome", ip: "203.0.113.9", js: true }),
  });
  assert.equal((await handleFunnel(request(event), env, { sqlFactory: factory })).status, 202);
  assert.equal((await handleFunnel(request({ ...event, event_id: "00000000-0000-4000-8000-000000000043", version: undefined }), env, { sqlFactory: factory })).status, 204);
  assert.ok(!JSON.stringify(calls.map((call) => call.params)).includes("203.0.113.9"));
  assert.ok(calls.some((call) => call.text.includes("insert into zevanory_funnel_events")));
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
  assert.deepEqual({ ...s.clean.pages["ia-na-pratica"] }, { views: 7 });
  assert.deepEqual(s.clean.sources.youtube, { views: 5, checkout_intent: 1, hotmart_view: 0, subscribe_click: 0, lead_submit: 0 });
  assert.deepEqual({ ...s.clean.campaigns }, { calc_20261012: 3 });
});

test("hostile utm labels cannot pollute prototypes or the summary", async () => {
  const rows = [{ page: "ia-na-pratica", metric: "src:__proto__", n: 3 }, { page: "ia-na-pratica", metric: "camp:constructor", n: 2 }, { page: "ia-na-pratica", metric: "views", n: 1 }];
  const s = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => (t.includes("group by page, metric") ? rows : []) }) });
  assert.equal(({}).views, undefined);
  assert.equal(Object.keys(s.clean.sources).length, 0);
  assert.equal(Object.keys(s.clean.campaigns).length, 0);
  assert.deepEqual(s.topCampaigns, []);
  const { factory, calls } = fakeSql(() => []);
  await handleFunnel(new Request("https://funnel.internal/hit", { method: "POST", body: JSON.stringify({ page: "ia-na-pratica", ua: "Mozilla/5.0 Chrome", ip: "203.0.113.9", src: "__proto__", camp: "constructor" }) }), { DATABASE_URL: "x" }, { sqlFactory: factory });
  assert.ok(calls.some((c) => c.params?.[2] === "src:direto"));
  assert.ok(!calls.some((c) => String(c.params?.[2] || "").includes("constructor")));
});

test("each counted view records a traffic class and network (no personal data)", async () => {
  assert.equal(trafficClass({ userAgent: "Mozilla/5.0 (iPhone) Mobile", acceptLanguage: true, country: "BR" }), "mobile_al_br");
  assert.equal(trafficClass({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome", acceptLanguage: false, country: "US" }), "desktop_noal_ext");
  assert.equal(trafficClass({ userAgent: "Mozilla/5.0", country: "" }), "desktop_noal_unk");
  const { factory, calls } = fakeSql(() => []);
  await handleFunnel(new Request("https://funnel.internal/hit", { method: "POST", body: JSON.stringify({ page: "lucro-e-caixa", ua: "Mozilla/5.0 (Linux; Android 14) Mobile", ip: "203.0.113.9", asn: 26599, al: 1, cty: "BR" }) }), { DATABASE_URL: "x" }, { sqlFactory: factory });
  assert.ok(calls.some((c) => c.params?.[2] === "cls:mobile_al_br"));
  assert.ok(calls.some((c) => c.params?.[2] === "asn:26599"));
  assert.ok(!calls.some((c) => JSON.stringify(c.params || []).includes("203.0.113.9")));
  const rows = [{ page: "solucoes", metric: "cls:desktop_noal_unk", n: 9 }, { page: "solucoes", metric: "asn:13335", n: 9 }];
  const s = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => (t.includes("day >= $1::date group by page, metric") ? rows : []) }) });
  assert.deepEqual({ ...s.clean.classes }, { desktop_noal_unk: 9 });
  assert.deepEqual({ ...s.clean.asn }, { 13335: 9 });
  assert.equal(s.clean.pages.solucoes, undefined);
});

test("unpaid-checkout diagnosis is aggregate-only and production-only", async () => {
  const q = (t) => t.includes("group by offer_id, status, provider") ? [{ offer_id: "ZEV-IA-011", status: "checkout_ready", provider: "mercadopago", n: 16 }]
    : t.includes("count(distinct session_id)") ? [{ orders: 19, sessions: 4, no_session: 0, max_per_session: 12 }]
    : t.includes("extract(hour") ? [{ h: 21, n: 7 }] : [];
  const prod = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "production" }, { sqlFactory: () => ({ query: async (t) => q(t) }) });
  assert.deepEqual(prod.checkoutDiag.byStatus, [{ offer: "ZEV-IA-011", status: "checkout_ready", provider: "mercadopago", n: 16 }]);
  assert.deepEqual(prod.checkoutDiag.sessions, { orders: 19, distinctSessions: 4, withoutSession: 0, maxOrdersPerSession: 12 });
  assert.deepEqual(prod.checkoutDiag.byHourBrt, { 21: 7 });
  assert.ok(!/order_id|email|phone|payer/.test(JSON.stringify(prod.checkoutDiag)));
  const test_ = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => q(t) }) });
  assert.equal(test_.checkoutDiag, null);
});
