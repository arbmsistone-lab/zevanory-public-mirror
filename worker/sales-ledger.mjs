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

// NC-989-01/02/03/04 (contra-auditorias do PR #989). O KV do Cloudflare não tem compare-and-set: a FONTE DE
// VERDADE são chaves imutáveis, e todo resumo é projeção.
//
// Evento (imutável por conteúdo, NC-989-03; particionado pela TRANSAÇÃO, NC-989-04):
//   zpc:sales:v1:ev:<bb>:<txhash32>:<desfecho>:<evento>:<payloadhash16>
//   bb = os 2 primeiros hex de txhash (256 baldes). Todos os eventos de uma transação caem SEMPRE no mesmo balde,
//   com ou sem data, então a projeção do balde agrupa por transação+desfecho e a deduplicação é GLOBAL por
//   construção (nenhuma transação aparece em dois baldes). A data de competência é só atributo do representativo
//   (byDay); sem data, a venda conta uma vez e fica fora de byDay (source.undated_groups).
//   payloadhash = sha256 dos fatos canônicos (sem o nome do evento): conteúdo igual ⇒ mesma chave e valor
//   idêntico; diferente ⇒ chave diferente; variantes ficam em divergent_events sem mudar a contagem.
// Cota (NC-989-02): o postback grava o evento e recalcula SÓ o seu balde (1 list de 1 página no volume de
// projeto), regravando zpc:sales:v1:bucket:<bb> só se a impressão digital mudou. Não há marcador nem documento
// compartilhado: uma projeção de balde calculada por um postback concorrente pode ficar defasada (nunca acima da
// verdade, pois vem de uma listagem); a varredura horária rotativa (10 baldes por hora, ciclo de 25,6 h, sem
// estado) e qualquer postback seguinte ao mesmo balde a corrigem. O recomputo horário lista o prefixo dos baldes
// (≤ 256 chaves, 1 página), varre 10 baldes e grava o total.
// COMPLETE com APPROVED de mesmo conteúdo já gravado não é regravado (mesmo desfecho e mesmos fatos).
// Legado: o resumo anterior é copiado UMA vez para SALES_LEGACY_BASELINE_KEY antes da primeira projeção; o
// marcador antigo zpc:sales:v1:txn:<ref>:<desfecho> = "1" deduplica.
export const SALES_EVENT_PREFIX = "zpc:sales:v1:ev:";
export const SALES_BUCKET_PREFIX = "zpc:sales:v1:bucket:";
export const SALES_LEGACY_BASELINE_KEY = "zpc:sales:v1:legacy-baseline";
export const SALES_EVENT_TTL_DAYS = 400;
export const BUCKET_HEX = 2;
export const BUCKETS = 16 ** BUCKET_HEX;
export const SWEEP_PER_RUN = 10;
const LEGACY_TXN_STATE = "zpc:sales:v1:txn:";
const EVENT_SCHEMA = "zevanory-sales-event/v3";
const BUCKET_SCHEMA = "zevanory-sales-bucket/v1";
const KV_LIST_LIMIT = 1000;
// Precedência do representativo de cada grupo transação+desfecho (independe da ordem de chegada).
const PRECEDENCE = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"];
const rank = (event) => { const i = PRECEDENCE.indexOf(event); return i < 0 ? PRECEDENCE.length : i; };
const kindOf = (event) => (APPROVED.has(event) ? "approved" : REVERSED[event] || OTHER[event] || null);
const outcomeOf = (event) => (APPROVED.has(event) ? "approved" : REVERSED[event] ? "reversed" : OTHER[event] || null);
const EVENT_NAME_RE = /^zpc:sales:v1:ev:([0-9a-f]{2}):([0-9a-f]{32}):([a-z_]+):([a-z_]+):([0-9a-f]{16})$/;
const parse = (raw) => { try { return JSON.parse(String(raw ?? "null")); } catch { return null; } };
const isSummary = (s) => s && s.schema === "zevanory-sales/v1";
export const bucketName = (i) => i.toString(16).padStart(BUCKET_HEX, "0");
// Baldes da varredura desta hora (sem estado): 10 consecutivos, ciclo de 256/10 = 25,6 h.
export function sweepBuckets(now) { const h = Math.floor(now / 3600000); return Array.from({ length: SWEEP_PER_RUN }, (_, i) => bucketName((h * SWEEP_PER_RUN + i) % BUCKETS)); }

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
  const ph = (await sha("facts:" + JSON.stringify(facts))).slice(0, 16);
  const h = (await sha("hotmart:" + txn)).slice(0, 32);
  const bucket = h.slice(0, BUCKET_HEX);
  const base = SALES_EVENT_PREFIX + bucket + ":" + h + ":" + outcome + ":";
  const meta = { schema: EVENT_SCHEMA, event, facts };
  return { bucket, h, ref: h.slice(0, 16), outcome, ph, base, key: base + event.toLowerCase() + ":" + ph, meta, value: JSON.stringify(meta) };
}

// `project: false` só grava a verdade (usado pela busca exaustiva da camada de eventos nos testes); o handler sempre projeta.
export async function recordHotmartSale(kv, event, data = {}, { now = Date.now(), project = true } = {}) {
  if (!kv?.get || !kv?.put) return { recorded: false, reason: "kv_unavailable" };
  const kind = kindOf(event);
  if (!kind) return { recorded: false, reason: "ignored_event" };
  const txn = String(data?.purchase?.transaction || "");
  if (!txn) return { recorded: false, reason: "missing_transaction" };
  const r = await salesEventRecord(event, txn, data);
  // Leituras que FALHAM (KV fora) propagam: o handler devolve 503 e nada é gravado.
  if ((await kv.get(LEGACY_TXN_STATE + r.ref + ":" + r.outcome)) === "1") return { recorded: false, reason: "duplicate", ref: r.ref, legacy: true };
  if ((await kv.get(r.key)) != null) {
    // Já gravado (reentrega): a tentativa anterior pode ter caído entre o evento e a projeção do balde.
    if (project) await refreshBucket(kv, r.bucket, { include: r });
    return { recorded: false, reason: "duplicate", kind, ref: r.ref };
  }
  let group = false, approvedTwin = false;
  for (const e of PRECEDENCE.filter((x) => x !== event && outcomeOf(x) === r.outcome)) {
    if ((await kv.get(r.base + e.toLowerCase() + ":" + r.ph)) != null) { group = true; if (e === "PURCHASE_APPROVED") approvedTwin = true; }
  }
  if (event === "PURCHASE_COMPLETE" && approvedTwin) return { recorded: false, reason: "duplicate", kind, ref: r.ref };
  // Gravação única e idempotente da verdade. Falha propaga (503) e a reentrega regrava o MESMO par chave/valor.
  await kv.put(r.key, r.value, { expirationTtl: SALES_EVENT_TTL_DAYS * DAY, metadata: r.meta });
  if (project) await refreshBucket(kv, r.bucket, { include: r });
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

// Projeção de UM balde: lista só o prefixo daquele balde (paginado) e agrupa por transação+desfecho.
// Falha de listagem ou leitura propaga. `include` acrescenta o evento recém-gravado (listagem eventual do KV).
export async function computeBucket(kv, bucket, { include = null } = {}) {
  const names = await listNames(kv, SALES_EVENT_PREFIX + bucket + ":");
  if (include?.key && include.bucket === bucket) names.set(include.key, include.meta);
  const groups = new Map();
  for (const [name, meta0] of names) {
    const m = EVENT_NAME_RE.exec(name);
    if (!m || m[1] !== bucket) continue;
    let meta = meta0;
    if (meta?.schema !== EVENT_SCHEMA) meta = parse(await kv.get(name));
    if (meta?.schema !== EVENT_SCHEMA || meta.event?.toLowerCase() !== m[4] || outcomeOf(meta.event) !== m[3]) continue;
    const id = m[2] + ":" + m[3];
    const g = groups.get(id) || { h: m[2], outcome: m[3], variants: new Map(), rep: null };
    groups.set(id, g);
    const vs = g.variants.get(meta.event) || new Set();
    vs.add(m[5]);
    g.variants.set(meta.event, vs);
    // Representativo: precedência do evento; depois o que tem data; depois o menor payloadhash.
    const better = (a, b) => rank(a.meta.event) - rank(b.meta.event) || (a.meta.facts?.at ? 0 : 1) - (b.meta.facts?.at ? 0 : 1) || a.ph.localeCompare(b.ph);
    const cand = { meta, ph: m[5], name };
    if (!g.rep || better(cand, g.rep) < 0) g.rep = cand;
  }
  const s = emptySummary();
  const divergent = [];
  let undated = 0;
  const reps = [...groups.values()].sort((a, b) => String(a.rep.meta.facts?.at || "").localeCompare(String(b.rep.meta.facts?.at || "")) || a.rep.name.localeCompare(b.rep.name));
  for (const g of reps) {
    applySale(s, g.rep.meta.facts, kindOf(g.rep.meta.event), g.h.slice(0, 16));
    if (!g.rep.meta.facts?.at) undated++;
    // Um COMPLETE gêmeo de um APPROVED (mesmo conteúdo) pode ou não estar gravado, conforme a corrida: não conta como variante.
    const twins = g.variants.get("PURCHASE_APPROVED") || new Set();
    for (const [event, set0] of g.variants) {
      const set = event === "PURCHASE_COMPLETE" ? new Set([...set0].filter((ph) => !twins.has(ph))) : set0;
      if (set.size > 1) divergent.push({ ref: g.h.slice(0, 16), outcome: g.outcome, event, variants: set.size });
    }
  }
  delete s.updatedAt;
  const fingerprint = (await sha([...names.keys()].sort().join("\n"))).slice(0, 32);
  const nameHashes = [...names.keys()].map(fnv).sort();
  return { schema: BUCKET_SCHEMA, bucket, fingerprint, nameHashes, events: names.size, groups: groups.size, undated_groups: undated, divergent_events: divergent, summary: s };
}

// Hash curto e determinístico do nome de um evento (FNV-1a 32 bits), só para a varredura detectar evento faltante.
const fnv = (str) => { let x = 0x811c9dc5; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x.toString(16).padStart(8, "0"); };

// Recalcula um balde e grava a projeção se a impressão digital mudou. Na varredura (`sweep`), grava só se a
// listagem tem evento que a projeção gravada não cobre (corrida reparada); a saída de eventos expirados (TTL)
// fica para a próxima gravação do balde, para a expiração não custar uma gravação por balde varrido.
export async function refreshBucket(kv, bucket, opts = {}) {
  const p = await computeBucket(kv, bucket, opts);
  const prev = parse(await kv.get(SALES_BUCKET_PREFIX + bucket));
  if (prev?.fingerprint === p.fingerprint) return { changed: false, p: prev };
  if (!p.events && !prev) return { changed: false, p };
  if (opts.sweep && prev?.schema === BUCKET_SCHEMA && Array.isArray(prev.nameHashes)) {
    const have = new Set(prev.nameHashes);
    if (p.nameHashes.every((x) => have.has(x))) return { changed: false, p: prev };
  }
  await kv.put(SALES_BUCKET_PREFIX + bucket, JSON.stringify(p), { expirationTtl: SALES_EVENT_TTL_DAYS * DAY });
  return { changed: true, p };
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

// Recomputo horário: varre 10 baldes e grava o total (soma das projeções dos baldes + base legada).
// Qualquer falha de listagem ou leitura propaga ANTES de gravar o total: nunca há total de lista parcial ou vazia.
export async function refreshSalesSummary(kv, { now = Date.now(), buckets = null } = {}) {
  const { baseline, existing } = await legacyBaseline(kv);
  const parts = new Map();
  for (const b of buckets || sweepBuckets(now)) { const { p } = await refreshBucket(kv, b, { sweep: true }); parts.set(b, p); }
  for (const name of (await listNames(kv, SALES_BUCKET_PREFIX)).keys()) {
    const b = name.slice(SALES_BUCKET_PREFIX.length);
    if (parts.has(b)) continue;
    const p = parse(await kv.get(name));
    if (p?.schema === BUCKET_SCHEMA) parts.set(b, p);
  }
  const live = [...parts.values()].filter((p) => p.events > 0).sort((a, b) => a.bucket.localeCompare(b.bucket));
  if (!live.length && !baseline && !existing) return null; // nenhum postback registrado: não prova zero
  const s = baseline ? JSON.parse(JSON.stringify(baseline)) : emptySummary();
  delete s.applied;
  s.recent = s.recent || [];
  const divergent = [];
  let events = 0, groups = 0, undated = 0;
  for (const p of live) {
    mergeInto(s, p.summary);
    divergent.push(...(p.divergent_events || []));
    events += p.events; groups += p.groups; undated += p.undated_groups || 0;
  }
  s.recent = s.recent.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")) || String(a.ref).localeCompare(String(b.ref))).slice(0, 40);
  const keep = new Set(Object.keys(s.byDay).sort().slice(-400));
  for (const d of Object.keys(s.byDay)) if (!keep.has(d)) delete s.byDay[d];
  s.updatedAt = new Date(now).toISOString();
  s.lastEventAt = s.recent.map((r) => r.at).filter(Boolean).sort().pop() || null;
  s.divergent_events = divergent.sort((a, b) => a.ref.localeCompare(b.ref) || a.event.localeCompare(b.event));
  s.source = { kind: "derived", prefix: SALES_EVENT_PREFIX, buckets: live.length, events, groups, undated_groups: undated, legacyBaseline: Boolean(baseline) };
  await kv.put(SALES_SUMMARY_KEY, JSON.stringify(s));
  return s;
}
