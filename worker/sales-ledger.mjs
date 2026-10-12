// ZEVANORY revenue ledger (Hotmart). Aggregate-only, PII-free.
// Called from the authenticated Hotmart postback (hottok, constant-time compare) after
// its own idempotency marker. It never touches payments, refunds, checkout or the sales
// switch: it only records what Hotmart reported, so the command center can show
// revenue, refunds, products and sources with honest provenance.
// Integrity: "webhook_authenticated" — the event is authenticated by hottok but not
// re-read from the Hotmart API. The panel shows that label next to every revenue number.
export const SALES_SUMMARY_KEY = "zpc:sales:v1:summary";
const TXN_STATE = "zpc:sales:v1:txn:";
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
  const d = bucket(s.byDay, facts.day, { approved: 0, grossCents: 0, netCents: 0, reversed: 0, reversedGrossCents: 0 });
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

// Idempotent per transaction and outcome: an approval is counted once even when Hotmart
// sends both APPROVED and COMPLETE; a reversal is counted once.
export async function recordHotmartSale(kv, event, data = {}, { now = Date.now() } = {}) {
  if (!kv?.get || !kv?.put) return { recorded: false, reason: "kv_unavailable" };
  const kind = APPROVED.has(event) ? "approved" : REVERSED[event] || OTHER[event];
  if (!kind) return { recorded: false, reason: "ignored_event" };
  const txn = String(data?.purchase?.transaction || "");
  const ref = txn ? (await sha("hotmart:" + txn)).slice(0, 16) : (await sha("hotmart-noref:" + event + ":" + now)).slice(0, 16);
  const outcome = kind === "approved" ? "approved" : REVERSED[event] ? "reversed" : kind;
  if (txn) {
    const stateKey = TXN_STATE + ref + ":" + outcome;
    if (await kv.get(stateKey)) return { recorded: false, reason: "duplicate" };
    await kv.put(stateKey, "1", { expirationTtl: 400 * DAY });
  }
  const facts = saleFacts(event, data, now);
  let current = null;
  try { current = JSON.parse(String(await kv.get(SALES_SUMMARY_KEY) || "null")); } catch {}
  const next = applySale(current, facts, kind, ref);
  await kv.put(SALES_SUMMARY_KEY, JSON.stringify(next));
  return { recorded: true, kind, ref };
}
