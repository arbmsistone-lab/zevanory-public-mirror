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

// NC-989-01/02/03 (contra-auditorias do PR #989). O KV do Cloudflare não tem compare-and-set: a FONTE DE VERDADE
// são chaves imutáveis, e todo resumo é projeção.
//
// Evento (NC-989-03, imutável por conteúdo):
//   zpc:sales:v1:ev:<AAAAMMDD>:<txhash32>:<desfecho>:<evento>:<payloadhash16>
//   AAAAMMDD = dia UTC ESTÁVEL da transação (approved_date, senão order_date do payload; os mesmos em APPROVED,
//   COMPLETE e estorno). Sem data no payload: partição "00000000" (nunca o relógio do servidor).
//   payloadhash = sha256 dos fatos canônicos (sem o nome do evento). Conteúdo igual ⇒ mesma chave e valor
//   idêntico; conteúdo diferente ⇒ chave diferente. Nenhuma gravação substitui evidência de outro conteúdo.
//   A contagem continua 1 por transação+desfecho; variantes do mesmo evento com conteúdo diferente ficam
//   preservadas e aparecem em divergent_events para revisão humana, sem mudar a contagem.
// Cota (NC-989-02): o postback NÃO lista nem recalcula nada. Grava o evento e, se a partição for "fria" (fora de
// hoje/ontem/anteontem UTC), um marcador zpc:sales:v1:dirty:<dia> com TTL de 12 h, regravado no máximo a cada 2 h.
// O marcador nunca é apagado: expira sozinho. Então não existe corrida de "apagar depois de recalcular"; todo
// evento é seguido de ≥ 10 h de marcador vivo (≥ 9 recomputos horários). O recomputo horário
// (refreshSalesSummary, em /api/internal/funnel/run) lista SÓ: os 3 dias quentes (ao vivo, sem gravar hoje e
// ontem), os dias com marcador, 1 dia da varredura rotativa (sem estado: hora mod 400, ciclo de ~17 dias) e o
// prefixo zpc:sales:v1:day: (≤ 401 chaves, 1 página); dias -2 a -7 ainda sem projeção gravada (recomputo perdido)
// também são calculados e gravados, mesmo vazios. A projeção do dia zpc:sales:v1:day:<dia> só é regravada
// quando a impressão digital (nomes dos eventos) muda. O total soma as projeções dos dias.
// COMPLETE com APPROVED de mesmo conteúdo já gravado não é regravado (mesmo desfecho e mesmos fatos: nada a
// preservar; economiza 1 gravação por venda).
// Legado: o resumo anterior é copiado UMA vez para SALES_LEGACY_BASELINE_KEY antes da primeira projeção; o
// marcador antigo zpc:sales:v1:txn:<ref>:<desfecho> = "1" deduplica.
export const SALES_EVENT_PREFIX = "zpc:sales:v1:ev:";
export const SALES_DAY_PREFIX = "zpc:sales:v1:day:";
export const SALES_DIRTY_PREFIX = "zpc:sales:v1:dirty:";
export const SALES_LEGACY_BASELINE_KEY = "zpc:sales:v1:legacy-baseline";
export const SALES_EVENT_TTL_DAYS = 400;
export const UNDATED = "00000000";
export const HOT_DAYS = 3;
export const DIRTY_TTL_S = 12 * 3600;
export const DIRTY_REFRESH_MS = 2 * 3600 * 1000;
export const SWEEP_SLOTS = 400;
export const CATCH_UP_DAYS = 6;
const LEGACY_TXN_STATE = "zpc:sales:v1:txn:";
const EVENT_SCHEMA = "zevanory-sales-event/v2";
const DAY_SCHEMA = "zevanory-sales-day/v1";
const KV_LIST_LIMIT = 1000;
const DAY_MS = DAY * 1000;
// Precedência do representativo de cada grupo transação+desfecho (independe da ordem de chegada).
const PRECEDENCE = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"];
const rank = (event) => { const i = PRECEDENCE.indexOf(event); return i < 0 ? PRECEDENCE.length : i; };
const kindOf = (event) => (APPROVED.has(event) ? "approved" : REVERSED[event] || OTHER[event] || null);
const outcomeOf = (event) => (APPROVED.has(event) ? "approved" : REVERSED[event] ? "reversed" : OTHER[event] || null);
const EVENT_NAME_RE = /^zpc:sales:v1:ev:(\d{8}):([0-9a-f]{32}):([a-z_]+):([a-z_]+):([0-9a-f]{16})$/;
const parse = (raw) => { try { return JSON.parse(String(raw ?? "null")); } catch { return null; } };
const isSummary = (s) => s && s.schema === "zevanory-sales/v1";
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
const dayMinus = (now, n) => dayOf(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - n * DAY_MS);
export const hotDays = (now) => Array.from({ length: HOT_DAYS }, (_, i) => dayMinus(now, i));
// Dia da varredura rotativa desta hora: -3 a -401 dias e a partição sem data, um por hora, sem estado.
export function sweepDay(now) { const i = Math.floor(now / 3600000) % SWEEP_SLOTS; return i === SWEEP_SLOTS - 1 ? UNDATED : dayMinus(now, HOT_DAYS + i); }

// Fatos determinísticos: só o payload. Sem data da compra: sem data (nunca o relógio do servidor).
export function eventFacts(event, data = {}) {
  const purchase = data.purchase || {};
  const when = Number(purchase.approved_date || purchase.order_date || 0);
  const known = Number.isFinite(when) && when > 1e12;
  const f = saleFacts(event, data, known ? when : 0);
  if (!known) { f.at = null; f.day = null; }
  delete f.event;
  return f;
}

// Chave e valor do evento. Tudo derivado do payload: mesma entrada ⇒ mesmo par.
export async function salesEventRecord(event, txn, data = {}) {
  const outcome = outcomeOf(event);
  if (!outcome || !txn) return null;
  const facts = eventFacts(event, data);
  // metadata do KV: ≤ 1.024 bytes; o nome do produto é encurtado de forma determinística se preciso.
  if (enc.encode(JSON.stringify(facts)).length > 800) facts.product = facts.product.slice(0, 24);
  const canon = JSON.stringify(facts);
  const ph = (await sha("facts:" + canon)).slice(0, 16);
  const h = (await sha("hotmart:" + txn)).slice(0, 32);
  const day = facts.at ? facts.at.slice(0, 10).replaceAll("-", "") : UNDATED;
  const base = SALES_EVENT_PREFIX + day + ":" + h + ":" + outcome + ":";
  const meta = { schema: EVENT_SCHEMA, event, facts };
  return { day, h, ref: h.slice(0, 16), outcome, ph, base, key: base + event.toLowerCase() + ":" + ph, meta, value: JSON.stringify(meta) };
}

async function markDirty(kv, day, now) {
  const at = Number(await kv.get(SALES_DIRTY_PREFIX + day));
  if (Number.isFinite(at) && at > now - DIRTY_REFRESH_MS) return false;
  await kv.put(SALES_DIRTY_PREFIX + day, String(now), { expirationTtl: DIRTY_TTL_S });
  return true;
}

export async function recordHotmartSale(kv, event, data = {}, { now = Date.now() } = {}) {
  if (!kv?.get || !kv?.put) return { recorded: false, reason: "kv_unavailable" };
  const kind = kindOf(event);
  if (!kind) return { recorded: false, reason: "ignored_event" };
  const txn = String(data?.purchase?.transaction || "");
  if (!txn) return { recorded: false, reason: "missing_transaction" };
  const r = await salesEventRecord(event, txn, data);
  // Leituras que FALHAM (KV fora) propagam: o handler devolve 503 e nada é gravado.
  if ((await kv.get(LEGACY_TXN_STATE + r.ref + ":" + r.outcome)) === "1") return { recorded: false, reason: "duplicate", ref: r.ref, legacy: true };
  const cold = !hotDays(now).includes(r.day);
  if ((await kv.get(r.key)) != null) {
    // Já gravado (reentrega). Garante o marcador: a tentativa anterior pode ter caído entre o evento e o marcador.
    if (cold) await markDirty(kv, r.day, now);
    return { recorded: false, reason: "duplicate", kind, ref: r.ref };
  }
  let group = false, approvedTwin = false;
  for (const e of PRECEDENCE.filter((x) => x !== event && outcomeOf(x) === r.outcome)) {
    if ((await kv.get(r.base + e.toLowerCase() + ":" + r.ph)) != null) { group = true; if (e === "PURCHASE_APPROVED") approvedTwin = true; }
  }
  if (event === "PURCHASE_COMPLETE" && approvedTwin) return { recorded: false, reason: "duplicate", kind, ref: r.ref };
  // Gravação única e idempotente da verdade. Falha propaga (503) e a reentrega regrava o MESMO par chave/valor.
  await kv.put(r.key, r.value, { expirationTtl: SALES_EVENT_TTL_DAYS * DAY, metadata: r.meta });
  if (cold) await markDirty(kv, r.day, now);
  return group ? { recorded: false, reason: "duplicate", kind, ref: r.ref } : { recorded: true, kind, ref: r.ref };
}

async function listNames(kv, prefix) {
  if (!kv?.list) throw new Error("kv_list_unavailable");
  const out = new Map();
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, cursor, limit: KV_LIST_LIMIT });
    for (const key of page?.keys || []) out.set(key.name, key.metadata ?? null);
    if (page?.list_complete) break;
    cursor = page?.cursor;
    if (!cursor) throw new Error("kv_list_cursor_missing");
  }
  return out;
}

// Projeção de UM dia: lista só o prefixo daquele dia (paginado). Falha de listagem ou leitura propaga.
export async function computeDay(kv, day) {
  const names = await listNames(kv, SALES_EVENT_PREFIX + day + ":");
  const groups = new Map();
  for (const [name, meta0] of names) {
    const m = EVENT_NAME_RE.exec(name);
    if (!m || m[1] !== day) continue;
    let meta = meta0;
    if (meta?.schema !== EVENT_SCHEMA) meta = parse(await kv.get(name));
    if (meta?.schema !== EVENT_SCHEMA || meta.event?.toLowerCase() !== m[4] || outcomeOf(meta.event) !== m[3]) continue;
    const id = m[2] + ":" + m[3];
    const g = groups.get(id) || { h: m[2], outcome: m[3], variants: new Map(), rep: null };
    groups.set(id, g);
    const vs = g.variants.get(meta.event) || new Set();
    vs.add(m[5]);
    g.variants.set(meta.event, vs);
    if (!g.rep || rank(meta.event) < rank(g.rep.meta.event) || (meta.event === g.rep.meta.event && m[5] < g.rep.ph)) g.rep = { meta, ph: m[5], name };
  }
  const s = emptySummary();
  const divergent = [];
  const reps = [...groups.values()].sort((a, b) => String(a.rep.meta.facts?.at || "").localeCompare(String(b.rep.meta.facts?.at || "")) || a.rep.name.localeCompare(b.rep.name));
  for (const g of reps) {
    applySale(s, g.rep.meta.facts, kindOf(g.rep.meta.event), g.h.slice(0, 16));
    for (const [event, set] of g.variants) if (set.size > 1) divergent.push({ ref: g.h.slice(0, 16), outcome: g.outcome, event, variants: set.size });
  }
  delete s.updatedAt;
  const fingerprint = (await sha([...names.keys()].sort().join("\n"))).slice(0, 32);
  return { schema: DAY_SCHEMA, day, fingerprint, events: names.size, groups: groups.size, divergent_events: divergent, summary: s };
}

function mergeInto(t, part) {
  if (!isSummary(part)) return;
  for (const [k, v] of Object.entries(part.totals || {})) t.totals[k] = (t.totals[k] || 0) + (Number(v) || 0);
  for (const dim of ["byDay", "byProduct", "bySource"]) for (const [k, b] of Object.entries(part[dim] || {})) {
    const cur = (t[dim][k] = t[dim][k] || {});
    for (const [f, v] of Object.entries(b || {})) cur[f] = (cur[f] || 0) + (Number(v) || 0);
  }
  for (const [k, v] of Object.entries(part.byPayment || {})) t.byPayment[k] = (t.byPayment[k] || 0) + (Number(v) || 0);
  t.recent = [...(t.recent || []), ...(part.recent || [])];
}

// Base congelada do resumo anterior a NC-989-01 (copiada antes de a primeira projeção sobrescrevê-lo).
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

// Recomputo horário. Grava as projeções de dia que mudaram (exceto hoje e ontem, sempre ao vivo) e o total.
// Qualquer falha de listagem ou leitura propaga ANTES de gravar o total: nunca há total de lista parcial ou vazia.
export async function refreshSalesSummary(kv, { now = Date.now() } = {}) {
  const { baseline, existing } = await legacyBaseline(kv);
  const hot = hotDays(now);
  const live = new Set(hot.slice(0, 2));
  const dirty = [...(await listNames(kv, SALES_DIRTY_PREFIX)).keys()].map((k) => k.slice(SALES_DIRTY_PREFIX.length)).filter((d) => /^\d{8}$/.test(d));
  const stored = new Set([...(await listNames(kv, SALES_DAY_PREFIX)).keys()].map((k) => k.slice(SALES_DAY_PREFIX.length)));
  // Recuperação de recomputos perdidos: dias -2 a -7 sem projeção gravada são calculados e gravados (mesmo vazios).
  const catchUp = Array.from({ length: CATCH_UP_DAYS }, (_, i) => dayMinus(now, 2 + i)).filter((d) => !stored.has(d));
  const touch = [...new Set([...hot, ...dirty, ...catchUp, sweepDay(now)])].sort();
  const computed = new Map();
  for (const day of touch) {
    const p = await computeDay(kv, day);
    computed.set(day, p);
    if (live.has(day)) continue;
    const prev = stored.has(day) ? parse(await kv.get(SALES_DAY_PREFIX + day)) : null;
    if (prev?.fingerprint === p.fingerprint) continue;
    if (!p.events && !prev && !catchUp.includes(day)) continue;
    await kv.put(SALES_DAY_PREFIX + day, JSON.stringify(p), { expirationTtl: SALES_EVENT_TTL_DAYS * DAY });
  }
  const days = new Map(computed);
  for (const day of stored) {
    if (days.has(day)) continue;
    const p = parse(await kv.get(SALES_DAY_PREFIX + day));
    if (p?.schema === DAY_SCHEMA) days.set(day, p);
  }
  const parts = [...days.values()].filter((p) => p.events > 0);
  if (!parts.length && !baseline && !existing) return null; // nenhum postback registrado: não prova zero
  const s = baseline ? JSON.parse(JSON.stringify(baseline)) : emptySummary();
  delete s.applied;
  s.recent = s.recent || [];
  const divergent = [];
  let events = 0, groups = 0, undated = 0;
  for (const p of parts.sort((a, b) => a.day.localeCompare(b.day))) {
    mergeInto(s, p.summary);
    divergent.push(...(p.divergent_events || []).map((d) => ({ day: p.day, ...d })));
    events += p.events; groups += p.groups;
    if (p.day === UNDATED) undated = p.groups;
  }
  s.recent = s.recent.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")) || String(a.ref).localeCompare(String(b.ref))).slice(0, 40);
  const keep = Object.keys(s.byDay).sort().slice(-400);
  for (const d of Object.keys(s.byDay)) if (!keep.includes(d)) delete s.byDay[d];
  s.updatedAt = new Date(now).toISOString();
  s.lastEventAt = s.recent.map((r) => r.at).filter(Boolean).sort().pop() || null;
  s.divergent_events = divergent;
  s.source = { kind: "derived", prefix: SALES_EVENT_PREFIX, days: parts.length, events, groups, undated_groups: undated, legacyBaseline: Boolean(baseline) };
  await kv.put(SALES_SUMMARY_KEY, JSON.stringify(s));
  return s;
}
