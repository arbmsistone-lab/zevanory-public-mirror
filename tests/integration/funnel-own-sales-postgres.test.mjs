// Funil v2 em PostgreSQL REAL com o esquema de produção (db/migrations): vendas do checkout próprio
// (1 por sessão de compra, 1º pagamento confirmado pelo provedor, dia em America/Sao_Paulo, certificação
// fora, marcadores de integridade) e deduplicação dos sinais (exposição, visitor-days, intenção 30 min).
// Usa o MESMO código de worker/funnel.mjs através de um sqlFactory que fala psql. Sem rede nem dinheiro.
// Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/funnel-own-sales-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureLeadSchema } from "../../worker/lead-magnet.mjs";
import { buildOwnCheckoutSales, recordSignal, recordExposure, recordPageView, buildFunnelSummary, v2Day } from "../../worker/funnel.mjs";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = /^[a-z0-9_]{1,40}$/.test(process.env.FUNNEL_V2_PG_DB || "") ? process.env.FUNNEL_V2_PG_DB : "ci_funnel_v2";
const lit = (v) => v === null || v === undefined ? "NULL" : Array.isArray(v) ? `ARRAY[${v.map(lit).join(",")}]::text[]` : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const psql = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c", sql], { encoding: "utf8" }).trim();
const inline = (q, p = []) => q.replace(/\$(\d+)/g, (_, k) => lit(p[Number(k) - 1]));
// sqlFactory backed by psql: statements returning rows come back as JSON.
const factory = () => ({ query: async (q, p = []) => {
  const s = inline(q, p).trim();
  if (/^select/i.test(s)) return JSON.parse(psql(`select coalesce(json_agg(x), '[]') from (${s}) x`) || "[]");
  if (/returning/i.test(s)) return JSON.parse(psql(`with x as (${s}) select coalesce(json_agg(x), '[]') from x`) || "[]");
  psql(s); return [];
} });
const env = { DATABASE_URL: "x", RESEND_API_KEY: "salt" };

function order({ provider = "mercadopago", status = "paid", session = randomUUID(), pilot = false, amount = "197.00" } = {}) {
  const id = randomUUID();
  psql(`insert into orders (order_id, request_id, session_id, experiment_id, offer_id, amount, currency, provider, external_reference, status, certification_pilot)
        values (${lit(id)}, ${lit(randomUUID())}, ${lit(session)}, 'EXP-0001', 'ZEV-IA-011', ${amount}, 'BRL', ${lit(provider)}, ${lit("ZEVANORY:EXP-0001:" + id)}, ${lit(status)}, ${pilot})`);
  return id;
}
function confirmed(orderId, { provider = "mercadopago", at = "2026-10-20 02:30:00+00", pay = randomUUID(), event = "payment_confirmed" } = {}) {
  psql(`insert into financial_events (provider_event_id, provider, provider_payment_id, normalized_event, provider_event_name, provider_status, external_reference, amount, received_at, order_id)
        values (${lit(provider + ":" + pay + ":" + event)}, ${lit(provider)}, ${lit(pay)}, ${lit(event)}, 'payment.updated', 'approved', 'ref', 197, ${lit(at)}, ${orderId ? lit(orderId) : "NULL"})`);
}

before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  const dir = new URL("../../db/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort())
    execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], { input: readFileSync(new URL(f, dir), "utf8"), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
});

test("V1 venda = 1 por sessão de compra no dia BRT do 1º pagamento confirmado; certificação, sem evento e evento órfão nunca contam", { skip: SKIP }, async () => {
  const a = order(); confirmed(a); confirmed(a, { pay: randomUUID(), at: "2026-10-20 05:00:00+00" }); // 2 eventos no mesmo pedido
  const s = randomUUID(); const b1 = order({ session: s }); const b2 = order({ provider: "asaas", session: s }); // failover MP -> Asaas na mesma sessão
  confirmed(b1, { at: "2026-10-21 12:00:00+00" }); confirmed(b2, { provider: "asaas", at: "2026-10-21 12:05:00+00" });
  const c = order({ provider: "asaas" }); confirmed(c, { provider: "asaas", at: "2026-10-21 13:00:00+00" });
  confirmed(order({ pilot: true }));                       // certificação
  order({ status: "paid" });                               // pago sem evento confirmado
  confirmed(null, { pay: "orfao" });                       // evento sem pedido
  confirmed(order({ status: "checkout_ready" }), { at: "2026-10-22 12:00:00+00" }); // status divergente
  const out = await buildOwnCheckoutSales(factory(), { production: true });
  assert.equal(out.counted, true);
  assert.deepEqual(out.byDay["2026-10-19"], { mercadopago: { confirmed: 1, grossCents: 19700 } }, "02:30 UTC de 20/10 = 19/10 em São Paulo");
  assert.deepEqual(out.byDay["2026-10-21"], { mercadopago: { confirmed: 1, grossCents: 19700 }, asaas: { confirmed: 1, grossCents: 19700 } }, "failover na mesma sessão conta 1 (provedor do 1º pagamento)");
  assert.deepEqual(out.integrity, { statusMismatch: 1, extraOrdersSameSession: 1, paidWithoutConfirmedEvent: 1, confirmedEventWithoutOrder: 1 });
  assert.ok(!JSON.stringify(out).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), "sem ids no resumo");
});

test("V2 modo teste nunca consulta pedidos e não conta nada", { skip: SKIP }, async () => {
  let asked = false;
  const out = await buildOwnCheckoutSales({ query: async () => { asked = true; return []; } }, { production: false });
  assert.equal(out.counted, false); assert.equal(out.mode, "test"); assert.equal(asked, false);
});

test("V3 sinais deduplicados no servidor: exposição por visitante/dia/página, visitor-days, intenção por janela de 30 min", { skip: SKIP }, async () => {
  const t0 = Date.parse("2026-10-22T10:01:00Z");
  const v = { sqlFactory: factory, ip: "203.0.113.9", userAgent: "Mozilla/5.0 Chrome" };
  for (const page of ["ia-na-pratica", "ia-na-pratica", "lucro-e-caixa"]) {
    await recordPageView(env, { ...v, page, now: t0 });
    await recordExposure(env, { ...v, page, cta: "waitlist", now: t0 });
  }
  await recordExposure(env, { ...v, page: "ia-na-pratica", cta: "waitlist", ip: "203.0.113.10", now: t0 });
  for (const dt of [0, 60e3, 31 * 60e3]) await recordSignal(env, { ...v, page: "ia-na-pratica", metric: "own_checkout_started", provider: "mercadopago", now: t0 + dt });
  await recordSignal(env, { ...v, page: "ia-na-pratica", metric: "own_checkout_started", provider: "", now: t0 });
  await recordSignal(env, { ...v, page: "ia-na-pratica", metric: "waitlist_click", now: t0 });
  await recordSignal(env, { ...v, page: "ia-na-pratica", metric: "waitlist_click", now: t0 + 5e3 });
  const n = (page, metric) => Number(psql(`select coalesce(sum(n),0) from zevanory_funnel_daily where day='2026-10-22' and page=${lit(page)} and metric=${lit(metric)}`));
  assert.equal(n("ia-na-pratica", "visitors"), 1, "legado visitor-page-days");
  assert.equal(n("lucro-e-caixa", "visitors"), 1, "mesma pessoa em outra página conta de novo no legado");
  assert.equal(n("__site__", "site_visitors"), 2, "visitor-days do site: 2 pessoas, não 3 páginas");
  assert.equal(n("ia-na-pratica", "waitlist_cta_view"), 2);
  assert.equal(n("lucro-e-caixa", "waitlist_cta_view"), 1);
  assert.equal(n("ia-na-pratica", "own_checkout_started"), 2, "10:01 e 10:02 na mesma janela; 10:32 é nova tentativa");
  assert.equal(n("ia-na-pratica", "own_checkout_started_raw"), 3, "contador bruto à parte; sem provedor não conta");
  assert.equal(n("ia-na-pratica", "own_checkout_started:prov:mercadopago"), 2);
  assert.equal(n("ia-na-pratica", "waitlist_click"), 1); assert.equal(n("ia-na-pratica", "waitlist_click_raw"), 2);
  assert.doesNotMatch(psql("select string_agg(page || vhash, ',') from zevanory_funnel_visitors"), /203\.0\.113/, "sem IP armazenado");
  // v2 rows use the America/Sao_Paulo day (same calendar as own-checkout sales): 01:30 UTC of 23/10 is 22/10.
  await recordExposure(env, { ...v, ip: "203.0.113.77", page: "ia-na-pratica", cta: "waitlist", now: Date.parse("2026-10-23T01:30:00Z") });
  assert.equal(n("__site__", "site_visitors"), 3);
  assert.equal(Number(psql("select coalesce(sum(n),0) from zevanory_funnel_daily where day='2026-10-23' and page='__site__'")), 0);
});

test("V4 resumo publica daily v2 só das páginas de produto, separa leads pendentes/confirmados e esconde a página reservada", { skip: SKIP }, async () => {
  await ensureLeadSchema(factory()); // the real lead table, as the Worker creates it
  psql(`insert into zevanory_leads (email, email_hash, consent_version, consent_at, status, created_at, confirmed_at) values
        ('a@x', 'h1', 'v1', now(), 'pending', now(), null), ('b@x', 'h2', 'v1', now(), 'confirmed', now() - interval '10 days', now()),
        ('c@x', 'h3', 'v1', now(), 'confirmed', now() - interval '20 days', now() - interval '20 days') on conflict do nothing`);
  psql(`insert into zevanory_funnel_daily (day, page, metric, n) values (${lit(v2Day())}, 'solucoes', 'waitlist_cta_view', 5), (${lit(v2Day())}, '__site__', 'site_visitors', 3), (${lit(v2Day())}, 'negocio-completo', 'buy_cta_view', 2)
        on conflict (day, page, metric) do update set n = excluded.n`);
  const s = await buildFunnelSummary(env, { sqlFactory: factory, production: false });
  const today = v2Day(); // v2 rows are keyed by the São Paulo day
  assert.equal(s.taxonomy, "zevanory-funnel/v2");
  assert.equal(s.daily[today].site_visitors, 3);
  assert.equal(s.daily[today].buy_cta_view, 2);
  assert.equal(s.daily[today].waitlist_cta_view ?? 0, 0, "página que não é produto fica fora do numerador/denominador");
  assert.equal(s.last7Days.leadsPending, 1); assert.equal(s.last7Days.leadsConfirmed, 1, "confirmado hoje conta pela data da confirmação; o de 20 dias não");
  assert.equal(s.last7Days.leads, 1, "legado: cadastros criados em 7 dias (pendentes + confirmados)");
  assert.ok(!("__site__" in s.pages) && !("__site__" in s.clean.pages));
  assert.equal(s.ownCheckout.mode, "test");
});
