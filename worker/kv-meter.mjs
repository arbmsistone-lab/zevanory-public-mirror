// KV write meter (owner order METACLOUD, phase A): every put/delete on the shared KV namespace
// logs one line {kvw: "<prefix>", op, src} — no keys beyond their prefix, no values. The census
// workflow tails the Worker and turns these lines into writes per prefix and per trigger.
// Workers Free: 1,000 KV writes per day for the WHOLE account (reset 00:00 UTC).
export function kvPrefix(key) {
  const k = String(key || "");
  const parts = k.split(/[:/]/).filter(Boolean);
  // Keep the stable head of the key (e.g. "zpc:cron:v1", "postsale:sent"); drop ids and dates.
  const head = [];
  for (const p of parts) {
    if (/^[0-9a-f-]{8,}$/i.test(p) || /^\d{4}-\d{2}-\d{2}/.test(p) || /^\d{6,}/.test(p) || head.length >= 3) break;
    head.push(p);
  }
  return head.join(":") || "(root)";
}

// METACLOUD phase C: quota-aware degradation. The hourly Command Center snapshot measures the
// account's KV writes today (Cloudflare analytics) and stores {pct, at} under BUDGET_KEY. When
// usage reaches SHED_AT_PCT, writes of observability/cache prefixes (P2/P3) are skipped so the
// remaining quota stays for P0/P1 (financial proof, sales switch, orders, OAuth, publications).
export const BUDGET_KEY = "zpc:kv:v1:budget";
export const SHED_AT_PCT = 70;
export const SHEDDABLE = Object.freeze(["zpc:cron:v1", "postsale:lastrun", "refund:watchdog", "zpc:backup:v1", "zpc:restore-drill", "zpc:support:v1", "whatsapp:observation", "whatsapp:instant", "voice-study", "zpc:creative-autonomy"]);
export const isSheddable = (prefix) => SHEDDABLE.some((p) => prefix === p || prefix.startsWith(p + ":"));
const BUDGET_TTL_MS = 10 * 60 * 1000;
const budgetMemo = globalThis.__ZEVANORY_KV_BUDGET__ || (globalThis.__ZEVANORY_KV_BUDGET__ = { at: 0, pct: null });
export async function currentBudgetPct(kv, now = Date.now(), memo = budgetMemo) {
  if (now - memo.at < BUDGET_TTL_MS) return memo.pct;
  memo.at = now;
  try {
    const b = JSON.parse(String(await kv.get(BUDGET_KEY) || "null"));
    // Only a same-day UTC reading counts: the quota resets at 00:00 UTC.
    memo.pct = b && b.day === new Date(now).toISOString().slice(0, 10) && Number.isFinite(Number(b.pct)) ? Number(b.pct) : null;
  } catch { memo.pct = null; }
  return memo.pct;
}

export function meterKv(kv, src, log = (line) => console.log(line), { memo = budgetMemo, now = () => Date.now() } = {}) {
  if (!kv || typeof kv !== "object" || kv.__metered) return kv;
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === "__metered") return true;
      const value = Reflect.get(target, prop);
      if ((prop === "put" || prop === "delete") && typeof value === "function") {
        return async (key, ...rest) => {
          const prefix = kvPrefix(key);
          if (isSheddable(prefix)) {
            const pct = await currentBudgetPct(target, now(), memo);
            if (pct != null && pct >= SHED_AT_PCT) { try { log(JSON.stringify({ kvw: prefix, op: "shed:" + prop, src, pct })); } catch {} return undefined; }
          }
          try { log(JSON.stringify({ kvw: prefix, op: prop, src })); } catch {}
          return value.call(target, key, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Env view whose private KV binding (and its Portuguese alias) is metered.
export function withMeteredKv(env, src, log, opts) {
  if (!env || typeof env !== "object") return env;
  const names = new Set(["ZEVANORY_PRIVATE_ARTIFACTS", "ZEVANORY_ARTEFATOS_PRIVADOS"]);
  const cache = new Map();
  return new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!names.has(prop) || !value) return value;
      if (!cache.has(prop)) cache.set(prop, meterKv(value, src, log, opts));
      return cache.get(prop);
    },
  });
}

// Heartbeats (P2): rewrite only when the outcome changed or the last record is older than
// maxAgeMs (50 min: an hourly beat still lands every cycle, the 30-minute isolated beat every other one,
// always inside the 2-hour freshness the autonomy inventory requires).
export async function putBeat(kv, key, beat, { maxAgeMs = 50 * 60 * 1000, now = Date.now(), ttl = 7 * 86400 } = {}) {
  if (!kv?.put) return "unavailable";
  const record = { ...beat, finishedAt: new Date(now).toISOString() };
  try {
    const prev = JSON.parse(String((await kv.get?.(key)) || "null"));
    const prevAt = Date.parse(String(prev?.finishedAt || ""));
    if (prev && JSON.stringify(prev.tasks || {}) === JSON.stringify(record.tasks || {}) && Number.isFinite(prevAt) && now - prevAt < maxAgeMs) return "unchanged";
  } catch {}
  await kv.put(key, JSON.stringify(record), { expirationTtl: ttl });
  return "written";
}
