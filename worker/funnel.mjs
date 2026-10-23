// Sales funnel measurement — privacy-first (no cookies, no raw IP stored).
// * Page views arrive only through the sales Worker's service binding (host funnel.internal),
//   so the public internet cannot inflate the numbers.
// * Unique visitors use a daily-rotating salted hash (ip|ua|day) that cannot be reversed or
//   linked across days.
// * Every hour the summary (last 30 days, per product) is written to the shared KV where the
//   control panel reads it to compute the paid-ads readiness metric.
import { liaActivation } from "./fase-a-lia.mjs";

export const FUNNEL_PRODUCTS = Object.freeze({
  "ia-na-pratica": { sku: "ZEV-IA-011", name: "IA na Prática" },
  "vendas-na-pratica": { sku: "ZEV-VEN-011", name: "Vendas na Prática" },
  "lucro-e-caixa": { sku: "ZEV-LCX-011", name: "Lucro & Caixa" },
  "combo-ia-vendas": { sku: "ZEV-CMB-011", name: "Combo IA + Vendas" },
  "negocio-completo": { sku: "ZEV-NGC-011", name: "Negócio Completo" },
});
const TRACKED_PAGES = new Set([...Object.keys(FUNNEL_PRODUCTS), "solucoes", "material-gratuito", "conteudo-pronto", "ferramentas", "ia-por-ramo", "afiliados", "kit-afiliado"]);
const isTrackedPage = page => TRACKED_PAGES.has(page) || /^(ia-para|calculadora)-[a-z-]{2,60}$/.test(String(page));
// Intent metrics counted next to views; each also carries the visitor's source.
// lead_submit: a free-material form accepted by the core (aggregate count + source label only, no lead identity).
// It is NOT a confirmed e-mail (double opt-in) nor a qualified lead; reports must keep the three apart.
export const METRIC_DEFINITIONS = Object.freeze({
  lead_submit: "formulário do material gratuito aceito (contagem agregada por origem); não é e-mail confirmado nem lead qualificado; não deduplicado por pessoa",
  "last7Days.leads": "inscrições registradas na tabela de leads nos últimos 7 dias (pendentes e confirmadas)",
  leads_qualified: "evento lead_qualified da telemetria; não é alimentado pelo material gratuito",
});
export const INTENT_METRICS = Object.freeze(["checkout_intent", "hotmart_view", "subscribe_click", "lead_submit"]);
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const label = (v, max) => { const x = String(v || "").toLowerCase(); return new RegExp(`^[a-z0-9_-]{1,${max}}$`).test(x) && !RESERVED_KEYS.has(x) ? x : ""; };
// Traffic-quality class of a counted view, so human and automated traffic can be told apart
// without personal data: device family, whether the browser sent Accept-Language, and country.
export function trafficClass({ userAgent = "", acceptLanguage = false, country = "" } = {}) {
  const dev = /Mobi|Android|iPhone|iPad/i.test(String(userAgent)) ? "mobile" : "desktop";
  const al = acceptLanguage ? "al" : "noal";
  const c = String(country || "").toUpperCase();
  const cty = c === "BR" ? "br" : /^[A-Z]{2}$/.test(c) ? "ext" : "unk";
  return `${dev}_${al}_${cty}`;
}
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|monitor|curl|wget|python|node-fetch|go-http|axios|okhttp|uptime|pingdom|semrush|ahrefs|zevanory/i;
// "zevanory" (not only "zevanory-monitor"): the hourly command-center probe GETs /comprar/<sku> as
// "zevanory-command-center" and was counted as checkout_intent whenever its runner left the ASN list.
const SUMMARY_KEY = "zpc-funnel:v1:summary";
// Datacenter/bot exclusion went live on 2026-10-12; earlier days are contaminated by our own
// audits and crawlers, so "clean" figures only count days from this date on.
export const CLEAN_SINCE = "2026-10-12";
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

// Cloud/datacenter networks (our own audits, monitors and headless browsers run
// there with ordinary-looking user agents). Real buyers browse from ISPs/carriers.
// Telegram's in-app browser on Android appends "Telegram-Android/<ver> (<device>)" to a normal mobile
// Chrome UA, so the word "telegram" blocked real people opening our Telegram links. The token is removed
// ONLY when the rest is a mobile browser UA; the result still goes through the full automation list
// (TelegramBot previews, headless, curl, python... stay blocked). A UA never proves a human: rate limits,
// honeypot and the datacenter-ASN filter remain the abuse controls.
const INAPP_TOKEN = /\s*\bTelegram-Android\/[\d.]+(?:\s*\([^)]*\))?/g;
const MOBILE_BROWSER = /^Mozilla\/5\.0 \((?:Linux; Android [^)]*|iPhone;[^)]*|iPad;[^)]*)\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)/;
export function isAutomationUA(ua) {
  const s = String(ua || "");
  if (!s) return true;
  return BOT_RE.test(MOBILE_BROWSER.test(s) ? s.replace(INAPP_TOKEN, "") : s);
}
export const DATACENTER_ASNS = Object.freeze(new Set([8075, 16509, 14618, 15169, 396982, 14061, 16276, 24940, 63949, 20473, 36351, 45102, 132203, 31898, 8987, 19527]));
export function isCountableView({ method, page, userAgent, purpose, asn = 0 }) {
  if (DATACENTER_ASNS.has(Number(asn))) return false;
  if (method !== "GET") return false;
  if (!isTrackedPage(page)) return false;
  if (isAutomationUA(userAgent)) return false;
  if (/prefetch|prerender/i.test(String(purpose || ""))) return false;
  return true;
}

const bump = (sql, day, page, metric) => sql.query(
  `insert into zevanory_funnel_daily (day, page, metric, n) values ($1::date, $2, $3, 1)
     on conflict (day, page, metric) do update set n = zevanory_funnel_daily.n + 1`, [day, page, metric]);
export async function recordPageView(env, { sqlFactory, page, ip, userAgent, metric = "views", src = "", camp = "", asn = 0, acceptLanguage = false, country = "", now = Date.now(), docs = null }) {
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureFunnelSchema(sql);
  const day = new Date(now).toISOString().slice(0, 10);
  const source = label(src, 24) || "direto", campaign = label(camp, 48);
  if (INTENT_METRICS.includes(metric)) {
    await bump(sql, day, page, metric);
    await bump(sql, day, page, `${metric}:src:${source}`);
    return;
  }
  await bump(sql, day, page, `src:${source}`);
  if (campaign) await bump(sql, day, page, `camp:${campaign}`);
  await bump(sql, day, page, `cls:${trafficClass({ userAgent, acceptLanguage, country })}`);
  const asnN = Number(asn);
  await bump(sql, day, page, `asn:${Number.isInteger(asnN) && asnN > 0 && asnN < 4294967296 ? asnN : 0}`);
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
  // P01 Fase A, "semana de teste" (protocolo v3; bandeira FASE_A_SEMANA_TESTE, padrão desligado): tráfego
  // marcado utm_campaign=sdt-<nicho> nas calculadoras (utm_source meta_* = pago). Qualificada = visitante único do dia (já filtrado de
  // robôs/datacenter acima), com Accept-Language e país BR. Só contagens agregadas, sem dado pessoal.
  // Também exige LIA e ROPA aprovados (AVAL 099 §2 / 101 §3, worker/fase-a-lia.mjs): sem eles, nada é contado.
  const sdt = String(env.FASE_A_SEMANA_TESTE || "").toLowerCase() === "on" && /^calculadora-/.test(String(page)) && (docs ? liaActivation(env, docs) : liaActivation(env)).active ? /^sdt-(confeitaria|loja-de-roupas|salao-e-barbearia)$/.exec(campaign) : null;
  if (sdt) {
    await bump(sql, day, page, `sdt:${sdt[1]}:visita`);
    if (/^meta_/.test(source)) await bump(sql, day, page, `sdt:${sdt[1]}:pago`); // meta_* = reservado a tráfego pago
    if (fresh.length && trafficClass({ userAgent, acceptLanguage, country }).endsWith("_al_br")) await bump(sql, day, page, `sdt:${sdt[1]}:qualificada`);
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
  // Where visitors and buying intent come from (30 days): views and intents per source,
  // plus the campaigns (creative/day tags) that brought the most visits.
  const sources = Object.create(null), campaigns = Object.create(null);
  for (const row of traffic) {
    const m = /^(?:([a-z_]+):)?src:([a-z0-9_-]+)$/.exec(row.metric);
    if (m) { const s = (sources[m[2]] = sources[m[2]] || { views: 0, checkout_intent: 0, hotmart_view: 0, subscribe_click: 0, lead_submit: 0 }); s[m[1] || "views"] += Number(row.n) || 0; continue; }
    const c = /^camp:([a-z0-9_-]+)$/.exec(row.metric);
    if (c && !RESERVED_KEYS.has(c[1])) campaigns[c[1]] = (campaigns[c[1]] || 0) + (Number(row.n) || 0);
  }
  const products = {};
  for (const [slug, meta] of Object.entries(FUNNEL_PRODUCTS)) {
    products[slug] = { name: meta.name, sku: meta.sku, views: 0, visitors: 0, checkouts: 0, paid: 0, refunded: 0, revenue: 0, checkoutErrors: 0 };
  }
  const pages = {};
  for (const row of traffic) {
    if (row.metric.includes(":")) continue;
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
  // Daily product-page views and buying intent (30 days) for before/after experiments.
  const productDaily = {};
  try {
    const dailyRows = await sql.query(`select day::text as day, metric, sum(n)::int as n from zevanory_funnel_daily
      where day > current_date - 30 and page = any($1) and metric in ('views','checkout_intent','hotmart_view') group by day, metric`, [Object.keys(FUNNEL_PRODUCTS)]);
    for (const row of dailyRows || []) {
      const d = String(row.day).slice(0, 10);
      const b = (productDaily[d] = productDaily[d] || { views: 0, intents: 0 });
      if (row.metric === "views") b.views += Number(row.n) || 0; else b.intents += Number(row.n) || 0;
    }
  } catch {}
  // Clean breakdown (only days after the bot/datacenter filter went live): per page, per source and
  // per campaign, so the commercial diagnosis never mixes contaminated days with real visitors.
  const cleanRows = await sql.query(`select page, metric, sum(n)::int as n from zevanory_funnel_daily
      where day >= $1::date group by page, metric`, [CLEAN_SINCE]).catch(() => []);
  const clean = { since: CLEAN_SINCE, pages: Object.create(null), sources: Object.create(null), campaigns: Object.create(null), classes: Object.create(null), asn: Object.create(null) };
  for (const row of cleanRows || []) {
    const n = Number(row.n) || 0;
    const m = /^(?:([a-z_]+):)?src:([a-z0-9_-]+)$/.exec(row.metric);
    if (m) { if (RESERVED_KEYS.has(m[2])) continue; const s = (clean.sources[m[2]] = clean.sources[m[2]] || { views: 0, checkout_intent: 0, hotmart_view: 0, subscribe_click: 0, lead_submit: 0 }); s[m[1] || "views"] += n; continue; }
    const c = /^camp:([a-z0-9_-]+)$/.exec(row.metric);
    if (c) { if (!RESERVED_KEYS.has(c[1])) clean.campaigns[c[1]] = (clean.campaigns[c[1]] || 0) + n; continue; }
    const k = /^cls:([a-z_]+)$/.exec(row.metric);
    if (k) { clean.classes[k[1]] = (clean.classes[k[1]] || 0) + n; continue; }
    const a = /^asn:(\d{1,10})$/.exec(row.metric);
    if (a) { clean.asn[a[1]] = (clean.asn[a[1]] || 0) + n; continue; }
    const p = (clean.pages[row.page] = clean.pages[row.page] || Object.create(null));
    p[row.metric] = (p[row.metric] || 0) + n;
  }
  // Keep the stored summary bounded: visitor-controlled labels (utm) can be arbitrary.
  const topN = (obj, n, val = (v) => v) => Object.fromEntries(Object.entries(obj).sort((x, y) => val(y[1]) - val(x[1])).slice(0, n));
  clean.sources = topN(clean.sources, 30, (v) => v.views || 0);
  clean.campaigns = topN(clean.campaigns, 50);
  clean.asn = topN(clean.asn, 40);
  clean.pages = topN(clean.pages, 60, (v) => v.views || 0);
  // Unpaid-checkout diagnosis (owner order 13/10): aggregate counts only — no ids, no amounts per
  // person, no contact data. Status, provider, BRT hour and whether one session retried many times.
  let checkoutDiag = null;
  if (production) {
    const [byStatus, sessions, byHour] = await Promise.all([
      sql.query(`select offer_id, status, coalesce(provider,'') as provider, count(*)::int as n from orders
         where created_at > now() - interval '30 days' and coalesce(certification_pilot,false) = false
         group by offer_id, status, provider`, []),
      sql.query(`select count(*)::int as orders, count(distinct session_id)::int as sessions,
              count(*) filter (where session_id is null)::int as no_session,
              coalesce(max(per),0)::int as max_per_session
         from (select session_id, count(*) over (partition by session_id) as per from orders
                where created_at > now() - interval '30 days' and coalesce(certification_pilot,false) = false) t`, []),
      sql.query(`select extract(hour from created_at at time zone 'America/Sao_Paulo')::int as h, count(*)::int as n from orders
         where created_at > now() - interval '30 days' and coalesce(certification_pilot,false) = false group by 1`, []),
    ]).catch(() => [[], [], []]);
    checkoutDiag = {
      byStatus: (byStatus || []).map((r) => ({ offer: String(r.offer_id || ""), status: String(r.status || ""), provider: String(r.provider || ""), n: Number(r.n) || 0 })),
      sessions: sessions?.[0] ? { orders: Number(sessions[0].orders) || 0, distinctSessions: Number(sessions[0].sessions) || 0, withoutSession: Number(sessions[0].no_session) || 0, maxOrdersPerSession: Number(sessions[0].max_per_session) || 0 } : null,
      byHourBrt: Object.fromEntries((byHour || []).map((r) => [String(r.h), Number(r.n) || 0])),
    };
  }
  const clean7 = await sql.query("select metric, coalesce(sum(n),0)::int as n from zevanory_funnel_daily where day >= greatest(current_date - 6, $1::date) and metric in ('views','visitors') group by metric", [CLEAN_SINCE]).catch(() => []);
  const cleanM = Object.fromEntries((clean7 || []).map(row=>[row.metric,Number(row.n)||0]));
  const metrics7 = Object.fromEntries(traffic7.map(row=>[row.metric,Number(row.n)||0]));
  const last7Days = {windowDays:7, views:metrics7.views||0, visitors:metrics7.visitors||0, cleanSince:CLEAN_SINCE, cleanViews:cleanM.views||0, cleanVisitors:cleanM.visitors||0, leads:Number(leads7[0]?.n)||0, checkouts:Number(checkouts7[0]?.n)||0, mode:production?"production":"test"};
  return {
    schema: "zevanory-funnel/v1",
    definitions: METRIC_DEFINITIONS,
    generatedAt: new Date(now).toISOString(),
    windowDays: 30,
    last7Days,
    salesMode: production ? "production" : "test",
    salesOpen,
    pages,
    products,
    sources,
    productDaily,
    clean,
    checkoutDiag,
    topCampaigns: Object.entries(campaigns).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([campaign, views]) => ({ campaign, views })),
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
  if (!isCountableView({ method: "GET", page, userAgent, purpose: body.purpose, asn: body.asn })) return new Response(null, { status: 204 });
  // A hit without metric is a page view (existing contract). A metric that is present but unknown is
  // dropped, never counted as a view: an older/newer caller must not inflate visits.
  const metric = body.metric == null || body.metric === "views" ? "views" : INTENT_METRICS.includes(body.metric) ? body.metric : null;
  if (!metric) return new Response(null, { status: 204 });
  const work = recordPageView(env, { sqlFactory, page, ip: String(body.ip || ""), userAgent, metric, src: body.src, camp: body.camp, asn: body.asn, acceptLanguage: body.al === 1 || body.al === true, country: String(body.cty || "").slice(0, 2) }).catch((e) => console.error("funnel_hit_failed", e instanceof Error ? e.message : String(e)));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return new Response(null, { status: 204 });
}
