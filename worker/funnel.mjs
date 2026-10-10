// Sales funnel measurement — privacy-first (no cookies, no raw IP stored).
// * Page views arrive only through the sales Worker's service binding (host funnel.internal),
//   so the public internet cannot inflate the numbers.
// * Unique visitors use a daily-rotating salted hash (ip|ua|day) that cannot be reversed or
//   linked across days.
// * Every hour the summary (last 30 days, per product) is written to the shared KV where the
//   control panel reads it to compute the paid-ads readiness metric.

export const FUNNEL_PRODUCTS = Object.freeze({
  "ia-na-pratica": { sku: "ZEV-IA-011", name: "IA na Prática" },
  "vendas-na-pratica": { sku: "ZEV-VEN-011", name: "Vendas na Prática" },
  "lucro-e-caixa": { sku: "ZEV-LCX-011", name: "Lucro & Caixa" },
  "combo-ia-vendas": { sku: "ZEV-CMB-011", name: "Combo IA + Vendas" },
  "negocio-completo": { sku: "ZEV-NGC-011", name: "Negócio Completo" },
});
const TRACKED_PAGES = new Set([...Object.keys(FUNNEL_PRODUCTS), "solucoes", "material-gratuito"]);
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|monitor|curl|wget|python|node-fetch|go-http|axios|okhttp|uptime|pingdom|semrush|ahrefs/i;
const SUMMARY_KEY = "zpc-funnel:v1:summary";
let schemaReady = false;

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureFunnelSchema(sql) {
  if (schemaReady) return;
  await sql.query(`create table if not exists zevanory_funnel_daily (
    day date not null, page text not null, metric text not null, n integer not null default 0,
    primary key (day, page, metric))`, []);
  await sql.query(`create table if not exists zevanory_funnel_visitors (
    day date not null, page text not null, vhash text not null,
    primary key (day, page, vhash))`, []);
  schemaReady = true;
}

export function isCountableView({ method, page, userAgent, purpose }) {
  if (method !== "GET") return false;
  if (!TRACKED_PAGES.has(page)) return false;
  if (!userAgent || BOT_RE.test(userAgent)) return false;
  if (/prefetch|prerender/i.test(String(purpose || ""))) return false;
  return true;
}

export async function recordPageView(env, { sqlFactory, page, ip, userAgent, now = Date.now() }) {
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureFunnelSchema(sql);
  const day = new Date(now).toISOString().slice(0, 10);
  const salt = String(env.RESEND_API_KEY || env.DATABASE_URL || "zevanory");
  const vhash = (await sha256Hex(`${day}|${ip}|${userAgent}|${salt}`)).slice(0, 32);
  await sql.query(
    `insert into zevanory_funnel_daily (day, page, metric, n) values ($1::date, $2, 'views', 1)
       on conflict (day, page, metric) do update set n = zevanory_funnel_daily.n + 1`, [day, page]);
  const fresh = await sql.query(
    `insert into zevanory_funnel_visitors (day, page, vhash) values ($1::date, $2, $3)
       on conflict do nothing returning vhash`, [day, page, vhash]);
  if (fresh.length) {
    await sql.query(
      `insert into zevanory_funnel_daily (day, page, metric, n) values ($1::date, $2, 'visitors', 1)
         on conflict (day, page, metric) do update set n = zevanory_funnel_daily.n + 1`, [day, page]);
  }
}

export async function buildFunnelSummary(env, { sqlFactory, now = Date.now(), production = String(env.MERCADOPAGO_ENV || "").toLowerCase() === "production", salesOpen = String(env.SALE_GLOBALLY_ENABLED || "").toLowerCase() === "true" } = {}) {
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureFunnelSchema(sql);
  const traffic = await sql.query(
    `select page, metric, sum(n)::int as n from zevanory_funnel_daily
      where day > current_date - 30 group by page, metric`, []);
  const commerce = production ? await sql.query(
    `select o.offer_id,
            count(*)::int as checkouts,
            count(*) filter (where o.status in ('paid','refunded','partially_refunded'))::int as paid,
            count(*) filter (where o.status in ('refunded','partially_refunded'))::int as refunded,
            coalesce(sum(o.amount) filter (where o.status = 'paid'), 0)::float as revenue,
            count(*) filter (where o.status = 'checkout_uncertain')::int as checkout_errors
       from orders o
      where o.created_at > now() - interval '30 days' and coalesce(o.certification_pilot, false) = false
      group by o.offer_id`, []) : [];
  const products = {};
  for (const [slug, meta] of Object.entries(FUNNEL_PRODUCTS)) {
    products[slug] = { name: meta.name, sku: meta.sku, views: 0, visitors: 0, checkouts: 0, paid: 0, refunded: 0, revenue: 0, checkoutErrors: 0 };
  }
  const pages = {};
  for (const row of traffic) {
    pages[row.page] = pages[row.page] || { views: 0, visitors: 0 };
    pages[row.page][row.metric] = Number(row.n) || 0;
    if (products[row.page]) products[row.page][row.metric] = Number(row.n) || 0;
  }
  for (const row of commerce) {
    const slug = Object.keys(FUNNEL_PRODUCTS).find((k) => FUNNEL_PRODUCTS[k].sku === row.offer_id);
    if (!slug) continue;
    Object.assign(products[slug], {
      checkouts: Number(row.checkouts) || 0, paid: Number(row.paid) || 0, refunded: Number(row.refunded) || 0,
      revenue: Number(row.revenue) || 0, checkoutErrors: Number(row.checkout_errors) || 0,
    });
  }
  // Order 45: read-only seven-day aggregate, no migration and no PII.
  const traffic7 = await sql.query("select metric, coalesce(sum(n),0)::int as n from zevanory_funnel_daily where day >= current_date - 6 and metric in ('views','visitors') group by metric", []);
  const checkouts7 = production ? await sql.query("select count(*)::int as n from orders where created_at >= current_date - interval '6 days' and coalesce(certification_pilot,false) = false", []) : [];
  // Read the existing double-opt-in lead table; do not create or alter schemas.
  const leads7 = await sql.query("select count(*)::int as n from zevanory_leads where created_at >= current_date - interval '6 days'", []);
  const metrics7 = Object.fromEntries(traffic7.map(row=>[row.metric,Number(row.n)||0]));
  const last7Days = {windowDays:7, views:metrics7.views||0, visitors:metrics7.visitors||0, leads:Number(leads7[0]?.n)||0, checkouts:Number(checkouts7[0]?.n)||0, mode:production?"production":"test"};
  return {
    schema: "zevanory-funnel/v1",
    generatedAt: new Date(now).toISOString(),
    windowDays: 30,
    last7Days,
    salesMode: production ? "production" : "test",
    salesOpen,
    pages,
    products,
  };
}

export async function publishFunnelSummary(env, deps) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv || !env.DATABASE_URL || !deps?.sqlFactory) return { ok: false, reason: "funnel_unconfigured" };
  const summary = await buildFunnelSummary(env, deps);
  await kv.put(SUMMARY_KEY, JSON.stringify(summary), { expirationTtl: 3 * 24 * 3600 });
  return { ok: true, at: summary.generatedAt };
}

// Service-binding endpoint (only reachable from the sales Worker).
export async function handleFunnel(request, env, { sqlFactory, ctx } = {}) {
  const url = new URL(request.url);
  if (url.hostname !== "funnel.internal") return null;
  if (url.pathname !== "/hit" || request.method !== "POST") return new Response("not_found", { status: 404 });
  let body = {};
  try { body = await request.json(); } catch {}
  const page = String(body.page || "");
  const userAgent = String(body.ua || "").slice(0, 300);
  if (!isCountableView({ method: "GET", page, userAgent, purpose: body.purpose })) return new Response(null, { status: 204 });
  const work = recordPageView(env, { sqlFactory, page, ip: String(body.ip || ""), userAgent }).catch((e) => console.error("funnel_hit_failed", e instanceof Error ? e.message : String(e)));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return new Response(null, { status: 204 });
}
