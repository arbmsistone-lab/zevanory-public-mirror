// ZEVANORY revenue ledger (Hotmart). Aggregate-only, PII-free.
// Called from the authenticated Hotmart postback (hottok, constant-time compare). It never touches payments, refunds, checkout or the sales
// switch: it only records what Hotmart reported, so the command center can show
// revenue, refunds, products and sources with honest provenance.
// Integrity: "webhook_authenticated" — the event is authenticated by hottok but not
// re-read from the Hotmart API. The panel shows that label next to every revenue number.
export const SALES_SUMMARY_KEY = "zpc:sales:v1:summary";
const DAY = 86400;
const enc = new TextEncoder();

const APPROVED = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
const REVERSED = { PURCHASE_REFUNDED: "refunded", PURCHASE_CHARGEBACK: "chargeback", PURCHASE_PROTEST: "protest" };
const OTHER = {
  PURCHASE_CANCELED: "canceled", PURCHASE_EXPIRED: "expired", PURCHASE_DELAYED: "delayed",
  PURCHASE_BILLET_PRINTED: "billet_printed", PURCHASE_OUT_OF_SHOPPING_CART: "abandoned",
  SUBSCRIPTION_CANCELLATION: "subscription_canceled",
};

async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const cents = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
const clean = (v, max = 60) => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);

// Hotmart v2 postback → normalized, PII-free facts.
export function saleFacts(event, data = {}, now = Date.now()) {
  const purchase = data.purchase || {};
  const gross = cents(purchase.price?.value ?? purchase.full_price?.value);
  const commissions = Array.isArray(data.commissions) ? data.commissions : [];
  const producer = commissions.find((c) => String(c?.source || "").toUpperCase() === "PRODUCER");
  const affiliate = commissions.filter((c) => String(c?.source || "").toUpperCase() === "AFFILIATE").reduce((s, c) => s + cents(c?.value), 0);
  const net = producer ? cents(producer.value) : 0;
  const origin = purchase.origin || {};
  const src = clean(origin.src || origin.sck || "") || "sem-origem";
  const when = Number(purchase.approved_date || purchase.order_date || 0);
  const at = new Date(Number.isFinite(when) && when > 1e12 ? when : now).toISOString();
  return {
    event,
    product: String(data.product?.name || "Produto Hotmart").slice(0, 80),
    productId: String(data.product?.id || "").slice(0, 20),
    grossCents: gross,
    netCents: net,
    netKnown: Boolean(producer),
    feesCents: producer ? Math.max(0, gross - net - affiliate) : 0,
    affiliateCents: affiliate,
    src,
    payment: clean(purchase.payment?.type || "") || "desconhecido",
    recurrent: Number(purchase.recurrence_number || 0) > 1,
    at,
    day: at.slice(0, 10),
  };
}

function emptySummary() {
  return {
    schema: "zevanory-sales/v1",
    provider: "hotmart",
    integrity: "webhook_authenticated",
    updatedAt: null,
    totals: { approved: 0, grossCents: 0, netCents: 0, netKnown: 0, feesCents: 0, affiliateCents: 0, refunded: 0, chargeback: 0, protest: 0, reversedGrossCents: 0, reversedNetCents: 0, canceled: 0, expired: 0, delayed: 0, billet_printed: 0, abandoned: 0, subscription_canceled: 0, recurrent: 0 },
    byDay: {}, byProduct: {}, bySource: {}, byPayment: {},
    recent: [],
  };
}
const bucket = (map, key, init) => (map[key] = map[key] || { ...init });

export function applySale(summary, facts, kind, txnRef) {
  const s = summary && summary.schema === "zevanory-sales/v1" ? summary : emptySummary();
  const t = s.totals;
  // Evento sem data no payload (NC-989-01: nunca o relógio do servidor) não entra em byDay.
  const d = facts.day ? bucket(s.byDay, facts.day, { approved: 0, grossCents: 0, netCents: 0, reversed: 0, reversedGrossCents: 0 }) : {};
  const p = bucket(s.byProduct, facts.product, { approved: 0, grossCents: 0, netCents: 0, reversed: 0 });
  const src = bucket(s.bySource, facts.src, { approved: 0, grossCents: 0, netCents: 0, reversed: 0 });
  if (kind === "approved") {
    t.approved++; t.grossCents += facts.grossCents; t.netCents += facts.netCents; t.feesCents += facts.feesCents; t.affiliateCents += facts.affiliateCents;
    if (facts.netKnown) t.netKnown++;
    if (facts.recurrent) t.recurrent++;
    for (const b of [d, p, src]) { b.approved++; b.grossCents += facts.grossCents; b.netCents += facts.netCents; }
    s.byPayment[facts.payment] = (s.byPayment[facts.payment] || 0) + 1;
  } else if (kind === "refunded" || kind === "chargeback" || kind === "protest") {
    t[kind]++; t.reversedGrossCents += facts.grossCents; t.reversedNetCents += facts.netCents;
    d.reversed++; d.reversedGrossCents += facts.grossCents; p.reversed++; src.reversed++;
  } else if (kind in t) {
    t[kind]++;
  }
  s.recent = [{ ref: txnRef, kind, product: facts.product, grossCents: facts.grossCents, netCents: facts.netCents, src: facts.src, at: facts.at }, ...(s.recent || [])].slice(0, 40);
  // Keep 400 days of daily buckets.
  const days = Object.keys(s.byDay).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 400))) delete s.byDay[old];
  s.updatedAt = new Date().toISOString();
  return s;
}

// NC-989-01 (contra-auditoria do PR #989): a FONTE DE VERDADE deixa de ser o resumo. O KV do Cloudflare não tem
// compare-and-set nem exclusão mútua, então qualquer leitura-modificação-gravação de um documento compartilhado
// perde incrementos entre entregas simultâneas. Cada postback grava uma chave IMUTÁVEL por transação, desfecho e
// evento: zpc:sales:v1:ev:<sha256("hotmart:"+transação)[0:32]>:<desfecho>:<evento>. O valor (e o metadata) é
// derivado SÓ do payload: a mesma entrada gera o mesmo par chave/valor, então gravações concorrentes ou
// repetidas são idempotentes por construção (last-writer-wins entre valores idênticos). O conteúdo final do
// prefixo é a UNIÃO dos eventos entregues com sucesso, qualquer que seja o entrelaçamento.
// O resumo (SALES_SUMMARY_KEY) é só PROJEÇÃO: deriveSalesSummary lista o prefixo (paginado, sem limite de
// tamanho), agrupa por transação+desfecho (1 venda por transação aprovada, 1 reversão por transação) e escolhe o
// representativo por precedência fixa, nunca pela ordem de chegada. A projeção é regravada no próprio postback
// (melhor esforço: uma falha da projeção não devolve 503, porque a verdade já está gravada) e a cada hora em
// /api/internal/funnel/run (chamado pelo snapshot da central antes de ler o resumo).
// Retenção: TTL de SALES_EVENT_TTL_DAYS (400) dias por evento, desde a primeira gravação (a reentrega de um evento
// já gravado não regrava nem estende o TTL).
// Legado (antes desta mudança): o resumo antigo é copiado UMA vez para SALES_LEGACY_BASELINE_KEY antes da primeira
// projeção (cópia byte a byte, idempotente) e somado como base congelada; o marcador antigo
// zpc:sales:v1:txn:<ref>:<desfecho> = "1" faz a reentrega de uma transação já contada no legado virar duplicata.
export const SALES_EVENT_PREFIX = "zpc:sales:v1:ev:";
export const SALES_LEGACY_BASELINE_KEY = "zpc:sales:v1:legacy-baseline";
export const SALES_EVENT_TTL_DAYS = 400;
const LEGACY_TXN_STATE = "zpc:sales:v1:txn:";
const EVENT_SCHEMA = "zevanory-sales-event/v1";
const KV_LIST_LIMIT = 1000;
// Precedência do representativo de cada grupo transação+desfecho (independe da ordem de chegada):
// APPROVED antes de COMPLETE; estorno definitivo antes de contestação e de protesto (o protesto é provisório).
const PRECEDENCE = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"];
const rank = (event) => { const i = PRECEDENCE.indexOf(event); return i < 0 ? PRECEDENCE.length : i; };
const kindOf = (event) => (APPROVED.has(event) ? "approved" : REVERSED[event] || OTHER[event] || null);
const outcomeOf = (event) => (APPROVED.has(event) ? "approved" : REVERSED[event] ? "reversed" : OTHER[event] || null);
const EVENT_NAME_RE = /^zpc:sales:v1:ev:([0-9a-f]{32}):([a-z_]+):([a-z_]+)$/;

// Fatos determinísticos do evento: só o payload (data da compra; senão o creation_date do postback; senão sem data).
export function eventFacts(event, data = {}, { eventAt = null } = {}) {
  const purchase = data.purchase || {};
  const when = Number(purchase.approved_date || purchase.order_date || eventAt || 0);
  const known = Number.isFinite(when) && when > 1e12;
  const f = saleFacts(event, data, known ? when : 0);
  if (!known) { f.at = null; f.day = null; }
  return f;
}

function eventRecord(event, data, opts) {
  const facts = eventFacts(event, data, opts);
  // metadata do KV tem limite de 1.024 bytes: o nome do produto é encurtado de forma determinística se preciso.
  let meta = { schema: EVENT_SCHEMA, event, facts };
  if (enc.encode(JSON.stringify(meta)).length > 1000) meta = { schema: EVENT_SCHEMA, event, facts: { ...facts, product: facts.product.slice(0, 24) } };
  return meta;
}

export async function salesEventKey(event, txn) {
  const outcome = outcomeOf(event);
  if (!outcome || !txn) return null;
  const h = (await sha("hotmart:" + txn)).slice(0, 32);
  return { h, ref: h.slice(0, 16), outcome, group: SALES_EVENT_PREFIX + h + ":" + outcome + ":", key: SALES_EVENT_PREFIX + h + ":" + outcome + ":" + event.toLowerCase() };
}

export async function recordHotmartSale(kv, event, data = {}, { now = Date.now(), eventAt = null, refresh = true } = {}) {
  if (!kv?.get || !kv?.put) return { recorded: false, reason: "kv_unavailable" };
  const kind = kindOf(event);
  if (!kind) return { recorded: false, reason: "ignored_event" };
  const txn = String(data?.purchase?.transaction || "");
  if (!txn) return { recorded: false, reason: "missing_transaction" };
  const k = await salesEventKey(event, txn);
  // Leituras que FALHAM (KV fora) propagam: o handler devolve 503 e nada é gravado.
  if ((await kv.get(LEGACY_TXN_STATE + k.ref + ":" + k.outcome)) === "1") return { recorded: false, reason: "duplicate", ref: k.ref, legacy: true };
  const siblings = PRECEDENCE.filter((e) => outcomeOf(e) === k.outcome);
  const events = siblings.includes(event) ? siblings : [event];
  let own = false, group = false;
  for (const e of events) {
    const v = await kv.get(k.group + e.toLowerCase());
    if (v != null) { group = true; if (e === event) own = true; }
  }
  const meta = eventRecord(event, data, { eventAt });
  // Gravação única e idempotente da verdade. Falha propaga (503) e a reentrega regrava o MESMO par chave/valor.
  if (!own) await kv.put(k.key, JSON.stringify(meta), { expirationTtl: SALES_EVENT_TTL_DAYS * DAY, metadata: meta });
  let projection = "skipped";
  if (refresh) {
    try { await refreshSalesSummary(kv, { now, include: [{ name: k.key, metadata: meta }] }); projection = "ok"; }
    catch { projection = "stale"; }
  }
  return group ? { recorded: false, reason: "duplicate", kind, ref: k.ref, projection } : { recorded: true, kind, ref: k.ref, projection };
}

async function listEvents(kv) {
  if (!kv?.list) throw new Error("kv_list_unavailable");
  const out = new Map();
  let cursor;
  do {
    const page = await kv.list({ prefix: SALES_EVENT_PREFIX, cursor, limit: KV_LIST_LIMIT });
    for (const key of page?.keys || []) out.set(key.name, key.metadata ?? null);
    if (page?.list_complete) break;
    cursor = page?.cursor;
    if (!cursor) throw new Error("kv_list_cursor_missing");
  } while (true);
  return out;
}

const parse = (raw) => { try { return JSON.parse(String(raw ?? "null")); } catch { return null; } };
const isSummary = (s) => s && s.schema === "zevanory-sales/v1";

// Base congelada do resumo anterior a NC-989-01. Lida do SALES_LEGACY_BASELINE_KEY; na primeira vez, o resumo
// atual que NÃO é projeção (sem "source") é copiado para lá ANTES de qualquer projeção sobrescrevê-lo.
async function legacyBaseline(kv) {
  const rawSummary = await kv.get(SALES_SUMMARY_KEY);
  const current = parse(rawSummary);
  if (isSummary(current) && !current.source) {
    await kv.put(SALES_LEGACY_BASELINE_KEY, String(rawSummary));
    return { baseline: current, existing: true };
  }
  const base = parse(await kv.get(SALES_LEGACY_BASELINE_KEY));
  return { baseline: isSummary(base) ? base : null, existing: Boolean(current) };
}

// Projeção pura do conjunto de eventos (+ base legada). Qualquer falha de leitura ou listagem propaga: a projeção
// nunca é calculada a partir de uma lista parcial ou vazia.
export async function deriveSalesSummary(kv, { now = Date.now(), include = [] } = {}) {
  const { baseline, existing } = await legacyBaseline(kv);
  const names = await listEvents(kv);
  for (const e of include) if (e?.name) names.set(e.name, e.metadata ?? names.get(e.name) ?? null);
  const groups = new Map();
  for (const [name, meta0] of names) {
    const m = EVENT_NAME_RE.exec(name);
    if (!m) continue;
    let meta = meta0;
    if (meta?.schema !== EVENT_SCHEMA) meta = parse(await kv.get(name));
    if (meta?.schema !== EVENT_SCHEMA || meta.event?.toLowerCase() !== m[3] || outcomeOf(meta.event) !== m[2]) continue;
    const id = m[1] + ":" + m[2];
    const cur = groups.get(id);
    if (!cur || rank(meta.event) < rank(cur.meta.event)) groups.set(id, { h: m[1], meta, name });
  }
  if (!groups.size && !baseline && !existing) return null; // nenhum postback registrado: não prova zero
  const s = baseline ? JSON.parse(JSON.stringify(baseline)) : emptySummary();
  delete s.applied;
  const reps = [...groups.values()].sort((a, b) => String(a.meta.facts?.at || "").localeCompare(String(b.meta.facts?.at || "")) || a.name.localeCompare(b.name));
  for (const r of reps) applySale(s, r.meta.facts, kindOf(r.meta.event), r.h.slice(0, 16));
  const last = reps.map((r) => r.meta.facts?.at).filter(Boolean).sort().pop() || null;
  s.updatedAt = new Date(now).toISOString();
  s.lastEventAt = last;
  s.source = { kind: "derived", prefix: SALES_EVENT_PREFIX, events: groups.size, legacyBaseline: Boolean(baseline) };
  return s;
}

export async function refreshSalesSummary(kv, opts = {}) {
  const s = await deriveSalesSummary(kv, opts);
  if (s) await kv.put(SALES_SUMMARY_KEY, JSON.stringify(s));
  return s;
}
