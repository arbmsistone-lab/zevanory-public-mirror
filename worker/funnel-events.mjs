export const FUNNEL_EVENT_VERSION = "1.0.0";
export const FUNNEL_EVENT_NAMES = Object.freeze(["visit", "lead", "checkout_started", "paid", "delivered", "refunded"]);
export const FUNNEL_EVENT_ORDER = Object.freeze([...FUNNEL_EVENT_NAMES]);
export const FUNNEL_EVENT_SCHEMA = Object.freeze({
  additionalProperties: false,
  required: Object.freeze(["event_id", "version", "name", "occurred_at", "page"]),
  properties: Object.freeze(["event_id", "version", "name", "occurred_at", "page", "product", "source"]),
});

const EVENT_FIELDS = new Set(FUNNEL_EVENT_SCHEMA.properties);
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|monitor|curl|wget|python|node-fetch|go-http|axios|okhttp|uptime|pingdom|semrush|ahrefs|zevanory/i;
const RATE_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[a-z0-9_-]{1,70}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export async function hashFunnelVisitor(day, ip, userAgent, secret) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("event_hash_secret_unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}|${ip}|${userAgent}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateFunnelEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (Object.keys(event).some((key) => !EVENT_FIELDS.has(key))) return false;
  if (!FUNNEL_EVENT_SCHEMA.required.every((key) => Object.hasOwn(event, key))) return false;
  if (!UUID.test(event.event_id) || event.version !== FUNNEL_EVENT_VERSION) return false;
  if (!FUNNEL_EVENT_NAMES.includes(event.name) || typeof event.page !== "string" || !LABEL.test(event.page)) return false;
  if (typeof event.occurred_at !== "string" || !DATE_TIME.test(event.occurred_at) || !Number.isFinite(Date.parse(event.occurred_at))) return false;
  const day = event.occurred_at.slice(0, 10);
  const [year, month, date] = day.split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day) return false;
  if (event.product !== undefined && (typeof event.product !== "string" || !LABEL.test(event.product))) return false;
  if (event.source !== undefined && (typeof event.source !== "string" || !/^[a-z0-9_-]{1,24}$/.test(event.source))) return false;
  return true;
}

export function isNextStage(previous, current) {
  if (current === "visit") return true;
  return FUNNEL_EVENT_ORDER[FUNNEL_EVENT_ORDER.indexOf(previous) + 1] === current;
}

export async function emitFunnelEvent(event, {
  store,
  visitorHash,
  userAgent = "",
  hasJavaScript = false,
  now = Date.now(),
  production = false,
  salesOpen = false,
  testMode = false,
  isBot = (ua) => BOT_UA.test(String(ua || "")),
} = {}) {
  if (!validateFunnelEvent(event)) return { accepted: false, reason: "invalid_event" };
  if (!store || !/^[a-f0-9]{64}$/.test(String(visitorHash || ""))) return { accepted: false, reason: "invalid_context" };
  if (hasJavaScript !== true || isBot(userAgent)) return { accepted: false, reason: "automated_or_no_js" };
  if (Date.parse(event.occurred_at) > now + 5 * 60_000) return { accepted: false, reason: "future_event" };

  const commercial = FUNNEL_EVENT_ORDER.indexOf(event.name) >= FUNNEL_EVENT_ORDER.indexOf("checkout_started");
  if (commercial && !salesOpen && !testMode) return { accepted: false, reason: "sales_closed" };
  if (await store.hasEvent(event.event_id)) return { accepted: false, reason: "duplicate" };

  const bucket = Math.floor(now / RATE_WINDOW_MS);
  if (!await store.consumeRateLimit(visitorHash, bucket, MAX_EVENTS_PER_WINDOW)) return { accepted: false, reason: "rate_limited" };

  const previous = await store.latestEvent(visitorHash, testMode);
  if (!isNextStage(previous?.name, event.name)) return { accepted: false, reason: "invalid_order" };
  if (!await store.insertEvent(event, visitorHash, testMode)) return { accepted: false, reason: "duplicate" };
  await store.incrementMetric(event, testMode);
  return { accepted: true, reason: "recorded" };
}

export function createSqlFunnelEventStore(sql) {
  return {
    async hasEvent(eventId) {
      const rows = await sql.query("select event_id from zevanory_funnel_events where event_id=$1", [eventId]);
      return Boolean(rows?.length);
    },
    async latestEvent(visitorHash, testMode) {
      const rows = await sql.query(
        `select event_name as name from zevanory_funnel_events where visitor_hash=$1 and is_test=$2
         order by case event_name when 'visit' then 0 when 'lead' then 1 when 'checkout_started' then 2
           when 'paid' then 3 when 'delivered' then 4 when 'refunded' then 5 else -1 end desc limit 1`,
        [visitorHash, testMode],
      );
      return rows?.[0] || null;
    },
    async consumeRateLimit(visitorHash, bucket, limit) {
      const rows = await sql.query(
        `insert into zevanory_funnel_event_rate (visitor_hash, bucket, event_count) values ($1, $2, 1)
         on conflict (visitor_hash, bucket) do update
           set event_count = zevanory_funnel_event_rate.event_count + 1
         where zevanory_funnel_event_rate.event_count < $3 returning event_count`,
        [visitorHash, bucket, limit],
      );
      await sql.query("delete from zevanory_funnel_event_rate where bucket < $1", [bucket - 1]);
      return Boolean(rows?.length);
    },
    async insertEvent(event, visitorHash, testMode) {
      const rows = await sql.query(
        `insert into zevanory_funnel_events (event_id, version, event_name, occurred_at, page, product, source, visitor_hash, is_test)
         values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9)
         on conflict (event_id) do nothing returning event_id`,
        [event.event_id, event.version, event.name, event.occurred_at, event.page, event.product || null, event.source || null, visitorHash, testMode],
      );
      return Boolean(rows?.length);
    },
    async incrementMetric(event, testMode) {
      if (testMode) return;
      await sql.query(
        `insert into zevanory_funnel_daily (day, page, metric, n) values ($1::date, $2, $3, 1)
         on conflict (day, page, metric) do update set n = zevanory_funnel_daily.n + 1`,
        [event.occurred_at.slice(0, 10), event.page, `event:${event.name}`],
      );
    },
  };
}
