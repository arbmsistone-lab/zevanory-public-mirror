// Funil v2 (AVAL Sol 23/10): vendas multimeios com integridade, lista de espera ≠ intenção ≠ lead,
// denominadores compatíveis, cinco conversões separadas e estado Hotmart derivado das seis sondas.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  combineSales, salesMetric, brtDay, knownCount, hotmartEdgeDays, funnelMetrics, windowDays, mergeDaily, classifyHotmartProbe, hotmartLockState, hotmartModeText,
  evaluateBuyFlow, WAITLIST_CLICK_INSTRUMENTED, WAITLIST_CAPTURE_LIVE, LEAD_CAPTURE, CLASSES,
} from "../scripts/audit/funnel-counting.mjs";
import { evaluateInventory } from "../scripts/audit/autonomy-inventory.mjs";
import worker from "../worker/sales-public-worker.mjs";

const now = Date.parse("2026-10-23T15:00:00Z");
const at = new Date(now - 30 * 60e3).toISOString();
const ledger = (byDay) => ({ schema: "zevanory-sales/v1", updatedAt: at, byDay });
const CLEAN = Object.freeze({ paidWithoutConfirmedEvent: 0, statusMismatch: 0, confirmedEventWithoutOrder: 0, extraOrdersSameSession: 0 });
const own = (byDay, integrity = CLEAN) => ({ mode: "production", counted: true, byDay, integrity: { ...integrity } });
const days30 = windowDays(now, 30);

test("vendas: checkout próprio por provedor + Hotmart, sem dupla contagem, completas só com as duas fontes", () => {
  const c = combineSales({ sales: ledger({ "2026-10-20": { approved: 1, grossCents: 19700, reversed: 1 } }), own: own({ "2026-10-21": { mercadopago: { confirmed: 2, grossCents: 39400 }, asaas: { confirmed: 1, grossCents: 19700 }, hotmart: { confirmed: 5, grossCents: 1 } } }), days: days30 });
  assert.equal(c.total, 4); assert.equal(c.complete, true);
  assert.deepEqual(c.checkoutProprio.byProvider, { mercadopago: 2, asaas: 1 });
  assert.equal(c.checkoutProprio.ignoredNonOwnProvider, 5, "rótulo Hotmart dentro do ledger próprio nunca conta");
  const m = salesMetric(c, { window: "30d", updatedAt: at, now, definition: "Vendas" });
  assert.equal(m.integrityClass, "COMPLETE"); assert.equal(m.source, "Checkout próprio (Mercado Pago/Asaas) + Hotmart");
  for (const k of ["window", "numerator", "dedup", "sources", "freshness"]) assert.ok(m[k], k);
  assert.match(m.definition, /Mercado Pago 2, Asaas 1/);
});

test("vendas: fonte ausente vira PARTIAL/MISSING, nunca zero silencioso; modo teste é zero verdadeiro", () => {
  const partial = salesMetric(combineSales({ sales: ledger({}), own: { mode: "production", counted: false }, days: days30 }), { window: "30d", updatedAt: at, now, definition: "V" });
  assert.equal(partial.integrityClass, "PARTIAL"); assert.match(partial.source, /NÃO VERIFICADO/);
  const none = combineSales({ sales: null, own: null, days: days30 });
  assert.equal(none.total, null);
  assert.equal(salesMetric(none, { window: "30d", updatedAt: at, now, definition: "V" }).integrityClass, "MISSING");
  const test_ = combineSales({ sales: ledger({}), own: { mode: "test", counted: false }, days: days30 });
  assert.equal(test_.total, 0); assert.equal(test_.complete, true);
  const noPostback = salesMetric(combineSales({ sales: null, own: own({}), days: days30 }), { window: "30d", updatedAt: at, now, definition: "V" });
  assert.equal(noPostback.value, null); assert.equal(noPostback.integrityClass, "PARTIAL", "Hotmart sem nenhum postback não prova zero: zero vira nulo");
  assert.equal(salesMetric(combineSales({ sales: ledger({}), own: own({}), days: days30 }), { window: "30d", updatedAt: "2026-10-22T00:00:00Z", now, definition: "V" }).integrityClass, "STALE");
});

for (const marker of ["paidWithoutConfirmedEvent", "statusMismatch", "confirmedEventWithoutOrder", "extraOrdersSameSession"]) {
  test(`vendas: marcador ${marker} > 0 impede COMPLETE, zero vira nulo e o contador é publicado`, () => {
    const c = combineSales({ sales: ledger({}), own: own({}, { ...CLEAN, [marker]: 1 }), days: days30 });
    assert.equal(c.complete, false);
    const m = salesMetric(c, { window: "30d", updatedAt: at, now, definition: "V" });
    assert.equal(m.value, null, "zero com marcador não é zero comprovado");
    assert.equal(m.integrityClass, "PARTIAL");
    assert.equal(m.integrityMarkers[marker], 1);
    assert.match(m.definition, new RegExp(marker + "=1"));
    assert.deepEqual(knownCount(m), { value: null, integrityClass: "PARTIAL", lowerBound: false });
    const withSale = salesMetric(combineSales({ sales: ledger({}), own: own({ [days30[2]]: { mercadopago: { confirmed: 1 } } }, { ...CLEAN, [marker]: 2 }), days: days30 }), { window: "30d", updatedAt: at, now, definition: "V" });
    assert.deepEqual([withSale.value, withSale.integrityClass], [1, "PARTIAL"], "positivo com marcador = limite inferior");
  });
}
test("vendas: marcador ausente no resumo conta como desconhecido (nunca limpo)", () => {
  const m = salesMetric(combineSales({ sales: ledger({}), own: own({}, {}), days: days30 }), { window: "30d", updatedAt: at, now, definition: "V" });
  assert.equal(m.integrityClass, "PARTIAL"); assert.equal(m.value, null);
});

test("vendas: janela por dia (BRT) e reembolsos à parte; previsão soma as duas fontes", () => {
  const c = combineSales({ sales: ledger({ "2026-09-01": { approved: 9 } }), own: own({ "2026-09-01": { mercadopago: { confirmed: 9 } }, "2026-10-23": { mercadopago: { confirmed: 1, grossCents: 100 } } }), days: days30 });
  assert.equal(c.total, 1, "fora da janela não entra");
  assert.deepEqual(mergeDaily(ledger({ "2026-10-23": { approved: 1, grossCents: 5 } }), own({ "2026-10-23": { asaas: { confirmed: 2, grossCents: 10 } } }))["2026-10-23"], { approved: 3, grossCents: 15 });
});

const funnel = (daily, extra = {}) => ({ generatedAt: at, daily, sources: { direto: { views: 100, checkout_intent: 20, hotmart_view: 5, subscribe_click: 1, lead_submit: 3, waitlist_cta_view: 7 } }, last7Days: { cleanVisitors: 50, leads: 2, leadsPending: 1, leadsConfirmed: 1 }, pages: {}, ...extra });
const fullDaily = (fill) => Object.fromEntries(windowDays(now, 30).map((d) => [d, { site_visitors: 10, ...fill(d) }]));

test("lista de espera é interesse, nunca lead nem intenção; clique externo não medido = MISSING", () => {
  const m = funnelMetrics({ funnel: funnel(fullDaily(() => ({ waitlist_cta_view: 3 }))), sales: ledger({}), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(m.waitlistCtaViews30.value, 90); assert.equal(m.waitlistCtaViews30.integrityClass, "COMPLETE");
  assert.equal(WAITLIST_CLICK_INSTRUMENTED, false);
  assert.equal(m.waitlistClicks30.value, null); assert.equal(m.waitlistClicks30.integrityClass, "MISSING");
  assert.equal(WAITLIST_CAPTURE_LIVE, false);
  assert.equal(m.waitlistLeadsConfirmed.integrityClass, "MISSING");
  assert.equal(m.conversions.waitlistCtr.integrityClass, "MISSING");
  assert.equal(m.conversions.waitlistCapture.integrityClass, "MISSING");
  assert.equal(m.leadsConfirmed7.value, 1, "só confirmados em Leads confirmados");
  assert.equal(m.leadsPending7.value, 1);
});

test("intenção transacional só com vendas abertas; série antiga fica LEGACY_MIXED e não é reclassificada", () => {
  const closed = funnelMetrics({ funnel: funnel(fullDaily(() => ({ waitlist_cta_view: 3 }))), sales: ledger({}), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(closed.transactionalIntent30.value, null, "sem dia aberto não existe intenção (não é zero de demanda)");
  assert.equal(closed.legacyMixedClicks30.value, 26); assert.equal(closed.legacyMixedClicks30.integrityClass, "LEGACY_MIXED");
  const open = funnelMetrics({ funnel: funnel(fullDaily(() => ({ buy_cta_view: 4, own_checkout_started: 1, own_checkout_started_raw: 3 }))), sales: ledger({}), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(open.transactionalIntent30.value, 30); assert.equal(open.transactionalIntent30.raw, 90);
  assert.equal(open.transactionalIntent30.integrityClass, "PARTIAL", "Hotmart/assinatura não observáveis");
});

test("cinco conversões separadas: mesmas janelas, dias fechados fora, nunca páginas vistas", () => {
  const d = windowDays(now, 30);
  const openSet = new Set(d.slice(0, 10)); // 10 dias abertos
  const daily = fullDaily((day) => (openSet.has(day) ? { buy_cta_view: 20, own_checkout_started: 2 } : { waitlist_cta_view: 5 }));
  const byDay = Object.fromEntries([...openSet].map((day) => [day, { mercadopago: { confirmed: 1, grossCents: 19700 } }]));
  const m = funnelMetrics({ funnel: funnel(daily), sales: ledger({}), own: own(byDay), now, funnelAt: at, salesAt: at });
  assert.equal(m.conversions.checkoutStart.value, 10, "20 intenções ÷ 200 expostos ao botão de compra");
  assert.equal(m.conversions.visitorToSale.value, 10, "10 vendas ÷ 100 visitor-days dos dias abertos (dias fechados fora)");
  assert.equal(m.conversions.visitorToSale.denominator, "visitantes elegíveis (visitor-days) nos dias abertos");
  assert.equal(m.conversions.checkoutCompletion.value, 50, "9 vendas ÷ 18 intenções com 24 h de maturação");
  for (const c of Object.values(m.conversions)) { assert.ok(CLASSES.includes(c.integrityClass)); assert.ok(c.numerator && c.denominator && c.window && c.dedup); }
});

test("visitantes: legado vira visitor-page-days; visitor-days com cobertura parcial é PARTIAL", () => {
  const partialDaily = { [new Date(now).toISOString().slice(0, 10)]: { site_visitors: 4 } };
  const m = funnelMetrics({ funnel: funnel(partialDaily), sales: ledger({}), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(m.visitorPageDays7.unit, "visitor-page-days");
  assert.equal(m.visitorDays7.value, 4); assert.equal(m.visitorDays7.integrityClass, "PARTIAL");
  assert.equal(m.pageviews30.unit, "pageviews");
  const legacy = funnelMetrics({ funnel: funnel(undefined), sales: ledger({}), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(legacy.visitorDays7.integrityClass, "MISSING", "resumo sem v2 não inventa visitor-days");
});

test("Hotmart: erro 049 = encerrada; oferta só 'aceitando' com prova positiva; P0 com vendas fechadas", () => {
  const closed049 = { slug: "ia-na-pratica", http: 200, finalPath: "/error", errorCode: "049", offerMarker: false };
  assert.equal(classifyHotmartProbe(closed049), "closed");
  assert.equal(classifyHotmartProbe({ http: 200, blockedText: true }), "closed");
  assert.equal(classifyHotmartProbe({ http: 200, finalPath: "/F107979716H", offerMarker: true }), "accepting");
  assert.equal(classifyHotmartProbe({ http: 200, finalPath: "/F107979716H", offerMarker: false }), "inconclusive");
  assert.equal(classifyHotmartProbe({ http: 0 }), "error");
  const six = ["a", "b", "c", "d", "e", "f"].map((slug) => ({ ...closed049, slug }));
  const lock = hotmartLockState(six, false);
  assert.equal(lock.state, "closed"); assert.equal(lock.severity, null);
  assert.match(hotmartModeText(lock), /0\/6 ofertas aceitando pagamento, 6\/6 encerradas \(erro 049\)/);
  const bypass = hotmartLockState([...six.slice(1), { slug: "a", http: 200, finalPath: "/X", offerMarker: true }], false);
  assert.equal(bypass.state, "p0_bypass"); assert.equal(bypass.severity, "P0");
  assert.equal(hotmartLockState([...six.slice(1), { slug: "a", http: 0 }], false).state, "unverified", "sem resposta não é fechado");
  assert.equal(hotmartLockState(six, true).state, "closed_while_open");
  const inv = (h, salesOpen) => evaluateInventory({ processes: [{ id: "hotmart-checkout", eligible: true, state: "autonomous", evidence: { type: "hotmart" } }] }, { hotmart: h, salesOpen }, now).processes[0];
  assert.equal(inv(six, false).proven, true);
  const p0 = inv(bypass.offers.map((o) => ({ slug: o.slug, http: 200, finalPath: o.state === "accepting" ? "/X" : "/error", errorCode: o.state === "accepting" ? null : "049", offerMarker: o.state === "accepting" })), false);
  assert.equal(p0.proven, false); assert.equal(p0.failed, true); assert.match(p0.how, /^P0/);
});

test("caminho de compra: com vendas fechadas o aviso de fechado é o estado esperado; divergência é falha", () => {
  const recs = [{ sku: "ZEV-IA-011", state: "closed" }];
  assert.deepEqual(evaluateBuyFlow(recs, false).map((r) => r.ok), [true]);
  assert.deepEqual(evaluateBuyFlow([{ state: "checkout" }], false).map((r) => r.ok), [false]);
  const inv = (buyFlow, salesOpen) => evaluateInventory({ processes: [{ id: "buy-flow", eligible: true, state: "autonomous", evidence: { type: "buyflow" } }] }, { buyFlow, salesOpen }, now).processes[0];
  assert.equal(inv(recs, false).proven, true);
  assert.equal(inv([{ state: "checkout" }], false).failed, true, "pagamento abrindo com vendas fechadas");
  assert.equal(inv(recs, null).proven, false, "interruptor desconhecido não prova nada");
});

// Sales Worker: exposure rides the page view; real intent only after the server created the session.
const hits = [];
const env = (open, checkoutStatus = 201) => ({
  CORE: { fetch: async (u, init = {}) => {
    u = String(u);
    if (u.includes("funnel.internal")) { hits.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.includes("/api/sales/status")) return new Response(JSON.stringify({ open }), { status: 200 });
    if (u.includes("checkout.internal")) return new Response(JSON.stringify({ checkout_url: "https://www.mercadopago.com.br/checkout/v1/redirect?x=1" }), { status: checkoutStatus });
    return new Response("{}", { status: 200 });
  } },
  ASSETS: { fetch: async () => new Response("<html><head></head><body><main><h1>x</h1></main></body></html>", { status: 200 }) },
});
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const req = (path, init = {}) => new Request("https://vendas.zevanory.api.br" + path, { ...init, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124", ...(init.headers || {}) } });

test("Worker de vendas: página de produto conta exposição ao CTA certo; intenção só após sessão criada", async () => {
  hits.length = 0;
  await worker.fetch(req("/ia-na-pratica"), env(false), ctx); await Promise.all(waits);
  assert.deepEqual(hits.map((h) => [h.page, h.metric, h.cta]), [["ia-na-pratica", "views", "waitlist"]]);
  hits.length = 0;
  await worker.fetch(req("/ia-na-pratica"), env(true), ctx); await Promise.all(waits);
  assert.equal(hits[0].cta, "buy");
  hits.length = 0;
  await worker.fetch(req("/ferramentas"), env(false), ctx); await Promise.all(waits);
  assert.equal(hits[0].cta, undefined, "página sem interruptor não é exposição");
  hits.length = 0;
  await worker.fetch(req("/comprar/ZEV-IA-011", { method: "POST" }), env(true), ctx); await Promise.all(waits);
  assert.deepEqual(hits.map((h) => [h.page, h.metric, h.provider]), [["ia-na-pratica", "own_checkout_started", "mercadopago"]]);
  hits.length = 0;
  await worker.fetch(req("/comprar/ZEV-IA-011", { method: "POST" }), env(true, 503), ctx); await Promise.all(waits);
  assert.equal(hits.filter((h) => h.metric === "own_checkout_started").length, 0, "sessão não criada = nenhuma intenção");
  hits.length = 0;
  await worker.fetch(req("/comprar/ZEV-IA-011", { method: "POST" }), env(false), ctx); await Promise.all(waits);
  assert.equal(hits.length, 0, "vendas fechadas: nada");
});

test("flags fixadas ao código: nenhum emissor de waitlist_click; captura de leads do Material gratuito está no ar", () => {
  const src = readTextNormalized(new URL("../worker/sales-public-worker.mjs", import.meta.url));
  assert.equal(/waitlist_click/.test(src), WAITLIST_CLICK_INSTRUMENTED, "ao instrumentar o clique, ligar WAITLIST_CLICK_INSTRUMENTED");
  const page = readTextNormalized(new URL("../sales-public/material-gratuito.html", import.meta.url));
  assert.equal(LEAD_CAPTURE.live, true);
  assert.match(page, /<form class="lead-form" method="post" action="\/material-gratuito\/inscrever">/);
  assert.match(src, /url\.pathname==="\/material-gratuito\/inscrever"\) return handleLead/);
});

// Runs the real snapshot main() against an in-memory KV and a closed-sales site; returns the snapshot.
async function runSnapshot({ funnelSummary = null, ledgerSummary = null, salesOpen = false } = {}) {
  const store = new Map();
  if (funnelSummary) store.set("zpc-funnel:v1:summary", JSON.stringify(funnelSummary));
  if (ledgerSummary) store.set("zpc:sales:v1:summary", JSON.stringify(ledgerSummary));
  const realFetch = globalThis.fetch, realLog = console.log;
  globalThis.fetch = async (u, o = {}) => {
    u = String(u);
    const res = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (u.includes("/storage/kv/")) {
      if (u.includes("/keys?")) return res(200, { result: [] });
      const k = decodeURIComponent(u.match(/values\/([^?]+)/)[1]);
      if ((o.method || "GET") === "PUT") { store.set(k, o.body); return res(200, {}); }
      return store.has(k) ? res(200, store.get(k)) : res(404, "");
    }
    if (u.includes("/api/sales/status")) return res(200, { open: salesOpen });
    if (u.includes("/comprar/")) return res(200, "<h1>Vendas abrem em breve</h1>");
    return res(200, {});
  };
  console.log = () => {};
  Object.assign(process.env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", KV_NAMESPACE_ID: "n" });
  try {
    const { main, SNAPSHOT_KEY } = await import("../scripts/audit/command-center-snapshot.mjs");
    await main();
    return JSON.parse(store.get(SNAPSHOT_KEY));
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
}
// A day well inside every window, in both calendars (São Paulo for own/v2, UTC key for the Hotmart ledger).
const inside = () => brtDay(Date.now() - 5 * 864e5);
const fSummary = (ownCheckout, day = inside()) => ({ generatedAt: new Date().toISOString(), daily: { [day]: { site_visitors: 3, waitlist_cta_view: 2 } }, sources: { direto: { views: 9, checkout_intent: 4 } }, last7Days: { cleanVisitors: 5, leads: 1, leadsPending: 0, leadsConfirmed: 1 }, pages: {}, products: {}, ownCheckout });
const lSummary = (byDay) => ({ schema: "zevanory-sales/v1", updatedAt: new Date().toISOString(), totals: {}, byDay });
const BANNED = /wa\.me|5588992545413|558892545413/i;

test("snapshot: Vendas (30d) soma checkout próprio + Hotmart com rótulo honesto; nada de 'Hotmart vendendo' constante", async () => {
  const day = inside();
  const snap = await runSnapshot({ funnelSummary: fSummary({ mode: "production", counted: true, byDay: { [day]: { mercadopago: { confirmed: 1, grossCents: 19700 } } }, integrity: { ...CLEAN } }), ledgerSummary: lSummary({ [day]: { approved: 1, grossCents: 24700 } }) });
  assert.equal(snap.funnel.sales30.value, 2);
  assert.equal(snap.funnel.sales30.source, "Checkout próprio (Mercado Pago/Asaas) + Hotmart");
  assert.deepEqual([snap.funnel.sales30.parts.checkoutProprio.total, snap.funnel.sales30.parts.hotmart.total], [1, 1]);
  assert.equal(snap.goals.find((g) => g.id === "first-sale").current, 2);
  assert.equal(snap.revenue.grossTotalCents.value, 44400);
  assert.equal(snap.funnel.intents30.value, null, "vendas fechadas: sem intenção transacional");
  assert.equal(snap.funnel.legacyMixedClicks30.value, 4);
  assert.equal(snap.funnel.leads7.value, 1); assert.match(snap.funnel.leads7.source, /confirmados/);
  assert.ok(snap.funnel.conversions && Object.keys(snap.funnel.conversions).length === 5);
  assert.doesNotMatch(snap.operations.checkoutMode, /Hotmart vendendo/);
  assert.match(snap.operations.checkoutMode, /^Vendas fechadas/);
  assert.ok(snap.operations.buyFlow.every((b) => b.state === "closed" && b.expected === "closed" && b.ok));
  assert.ok(!snap.recommendations.some((r) => /checkout da Hotmart/.test(r.action)), "nunca recomenda contornar a trava");
});

test("falso zero proibido: fonte desconhecida propaga null/PARTIAL a marcos, previsão, recomendação e lista do dono", async () => {
  assert.deepEqual(knownCount({ value: 0, integrityClass: "PARTIAL" }), { value: null, integrityClass: "PARTIAL", lowerBound: false });
  assert.deepEqual(knownCount({ value: 2, integrityClass: "PARTIAL" }), { value: 2, integrityClass: "PARTIAL", lowerBound: true });
  assert.deepEqual(knownCount({ value: 0, integrityClass: "COMPLETE" }), { value: 0, integrityClass: "COMPLETE", lowerBound: false });
  const unknown = await runSnapshot({ funnelSummary: fSummary({ mode: "production", counted: false, byDay: {} }), ledgerSummary: lSummary({}) });
  for (const id of ["first-sale", "paid-traffic", "fortnight", "month"]) {
    const g = unknown.goals.find((x) => x.id === id);
    assert.equal(g.current, null, id + ": nunca 0 com fonte faltando"); assert.equal(g.integrityClass, "PARTIAL", id);
  }
  assert.equal(unknown.forecast.status, "unverified");
  assert.ok(unknown.recommendations.some((r) => /NÃO VERIFICADAS/.test(r.title)));
  assert.ok(!unknown.recommendations.some((r) => /\(0\/7 vendas\)/.test(r.title)));
  assert.match(unknown.autonomy.ownerOnly.find((x) => /tráfego pago/i.test(x.what)).status, /não verificadas/);
  assert.equal(unknown.revenue.grossTotalCents.value, null);
  const lower = await runSnapshot({ funnelSummary: fSummary({ mode: "production", counted: false, byDay: {} }), ledgerSummary: lSummary({ [inside()]: { approved: 1, grossCents: 100 } }) });
  const g = lower.goals.find((x) => x.id === "first-sale");
  assert.deepEqual([g.current, g.lowerBound, g.integrityClass], [1, true, "PARTIAL"], "parcial > 0 é limite inferior, declarado");
  assert.ok(lower.recommendations.some((r) => r.title === "Tráfego pago bloqueado (≥1/7 vendas)"));
  assert.equal(lower.forecast.status, "unverified");
  assert.equal(lower.revenue.grossTotalCents.value, null, "receita parcial não vira meta atingida/medida");
  assert.equal(lower.goals.find((x) => x.id === "month").current, null);
});

test("métricas antigas só-Hotmart removidas; nenhum número/link de WhatsApp no snapshot nem no código novo", async () => {
  const snap = await runSnapshot({ funnelSummary: fSummary({ mode: "test", counted: false, byDay: {} }), ledgerSummary: lSummary({}) });
  for (const k of ["netMonthCents", "netTotalCents", "feesCents", "affiliateCents", "refunds", "refundedCents", "avgTicketCents", "abandoned", "declined", "byProduct", "bySource", "byPayment", "recent"]) assert.ok(!(k in snap.revenue), "removida: " + k);
  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /Hotmart \(postback autenticado\)/, "nenhuma métrica rotulada só Hotmart");
  assert.doesNotMatch(text, BANNED);
  for (const f of ["../scripts/audit/funnel-counting.mjs", "../scripts/audit/autonomy-inventory.mjs", "../scripts/ci/mutants_funnel_v2.py", "../.github/workflows/funnel-v2.yml", "./integration/funnel-own-sales-postgres.test.mjs", "../worker/funnel.mjs"])
    assert.doesNotMatch(readTextNormalized(new URL(f, import.meta.url)), BANNED, f);
  // Lines this PR adds to the sales Worker (exposure + server-side intent) carry no contact link.
  const spw = readTextNormalized(new URL("../worker/sales-public-worker.mjs", import.meta.url)).split("\n").filter((l) => /own_checkout_started|toggleOpen|extra=null|\{cta:/.test(l));
  assert.ok(spw.length >= 3); for (const l of spw) assert.doesNotMatch(l, BANNED);
});

test("intenção legada removida: abrir /comprar/ não conta nada; só a sessão criada no servidor conta", async () => {
  const src = readTextNormalized(new URL("../worker/sales-public-worker.mjs", import.meta.url));
  assert.doesNotMatch(src, /"checkout_intent"/, "nenhum emissor de checkout_intent");
  hits.length = 0;
  await worker.fetch(req("/comprar/ZEV-IA-011"), env(true), ctx); await Promise.all(waits);
  assert.equal(hits.length, 0, "GET da página de compra com vendas abertas não é intenção");
});

test("calendário único: Hotmart (dia UTC) na borda da janela torna o total PARTIAL; conversão visitante→venda PARTIAL com Hotmart", () => {
  const days = windowDays(now, 30);
  const [first, next] = hotmartEdgeDays(days);
  assert.equal(first, days[days.length - 1]); assert.equal(next, "2026-10-24");
  const edge = salesMetric(combineSales({ sales: ledger({ [first]: { approved: 1 } }), own: own({}), days }), { window: "30d", updatedAt: at, now, definition: "V" });
  assert.equal(edge.integrityClass, "PARTIAL");
  const mid = salesMetric(combineSales({ sales: ledger({ [days[10]]: { approved: 1 } }), own: own({}), days }), { window: "30d", updatedAt: at, now, definition: "V" });
  assert.equal(mid.integrityClass, "COMPLETE");
  const daily = fullDaily(() => ({ buy_cta_view: 5 }));
  const ok = funnelMetrics({ funnel: funnel(daily), sales: ledger({}), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(ok.conversions.visitorToSale.integrityClass, "COMPLETE", "mesmo calendário dos dois lados");
  const withHot = funnelMetrics({ funnel: funnel(daily), sales: ledger({ [days[3]]: { approved: 1 } }), own: own({}), now, funnelAt: at, salesAt: at });
  assert.equal(withHot.conversions.visitorToSale.integrityClass, "PARTIAL");
});
