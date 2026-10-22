import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createSqlFunnelEventStore, emitFunnelEvent, hashFunnelVisitor } from "../../worker/funnel-events.mjs";
import { ensureFunnelSchema } from "../../worker/funnel.mjs";

const HOST = process.env.P15_PG_HOST;
const PORT = process.env.P15_PG_PORT || "5432";
if (!HOST) throw new Error("P15_PG_HOST must point to a disposable PostgreSQL instance");

const lit = (value) => value === null || value === undefined ? "NULL" : "'" + String(value).replace(/'/g, "''") + "'";
const args = ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "--csv", "-q", "-c"];
const parseCsv = (line) => {
  const cells = [];
  let current = "", quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(current); current = ""; }
    else current += char;
  }
  cells.push(current);
  return cells;
};
const psql = (sql) => execFileSync("psql", [...args, sql], { encoding: "utf8" }).trim();
const psqlAsync = (sql) => new Promise((resolve, reject) => execFile("psql", [...args, sql], { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
const sqlFactory = () => ({
  query: async (text, params = []) => {
    const query = text.replace(/\$(\d+)/g, (_, index) => lit(params[Number(index) - 1]));
    const output = await psqlAsync(query);
    if (!output) return [];
    const [header, ...lines] = output.split("\n");
    const columns = parseCsv(header);
    return lines.map((line) => Object.fromEntries(parseCsv(line).map((value, index) => [columns[index], value === "" ? null : value])));
  },
});
const visitor = (letter) => letter.repeat(64);
const event = (name, id, time = Date.now()) => ({
  event_id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  version: "1.0.0",
  name,
  occurred_at: new Date(time).toISOString(),
  page: "ia-na-pratica",
});
const emit = (store, value, hash, options = {}) => emitFunnelEvent(value, {
  store,
  visitorHash: hash,
  userAgent: "Mozilla/5.0 Chrome/130",
  hasJavaScript: true,
  now: Date.now(),
  testMode: true,
  salesOpen: false,
  ...options,
});

before(async () => {
  psql("drop table if exists zevanory_funnel_event_rate; drop table if exists zevanory_funnel_events; drop table if exists zevanory_funnel_visitors; drop table if exists zevanory_funnel_daily");
  await ensureFunnelSchema(sqlFactory());
});

test("PostgreSQL serializes the highest funnel stage across repeated visits", async () => {
  const store = createSqlFunnelEventStore(sqlFactory());
  const hash = visitor("a");
  assert.equal((await emit(store, event("visit", 1), hash)).accepted, true);
  assert.equal((await emit(store, event("lead", 2), hash)).accepted, true);
  assert.equal((await emit(store, event("visit", 3), hash)).accepted, true);
  assert.equal((await emit(store, event("checkout_started", 4), hash)).accepted, true);
  assert.equal((await store.latestEvent(hash, true)).name, "checkout_started");
});

test("separate SQL store instances share the exact distributed rate limit", async () => {
  const first = createSqlFunnelEventStore(sqlFactory());
  const second = createSqlFunnelEventStore(sqlFactory());
  const hash = visitor("b");
  const outcomes = await Promise.all(Array.from({ length: 24 }, (_, index) => emit(
    index % 2 ? first : second,
    event("visit", 100 + index),
    hash,
  )));
  assert.equal(outcomes.filter((outcome) => outcome.accepted).length, 20);
  assert.equal(outcomes.filter((outcome) => outcome.reason === "rate_limited").length, 4);
  assert.deepEqual(psql(`select event_count from zevanory_funnel_event_rate where visitor_hash=${lit(hash)}`), "event_count\n20");
  assert.deepEqual(psql(`select count(*)::int as n from zevanory_funnel_events where visitor_hash=${lit(hash)}`), "n\n20");
});

test("duplicate event IDs are counted once by the PostgreSQL unique constraint", async () => {
  const store = createSqlFunnelEventStore(sqlFactory());
  const hash = visitor("c");
  const value = event("visit", 200);
  assert.equal((await emit(store, value, hash)).accepted, true);
  assert.deepEqual(await emit(store, value, hash), { accepted: false, reason: "duplicate" });
  assert.deepEqual(psql(`select count(*)::int as n from zevanory_funnel_events where event_id=${lit(value.event_id)}::uuid`), "n\n1");
});

test("dedicated HMAC secret produces a stable anonymous hash and schema stores no PII", async () => {
  const secret = "synthetic-event-hash-secret-for-e2e-0001";
  const first = await hashFunnelVisitor("2026-10-22", "203.0.113.10", "Mozilla/5.0 Chrome", secret);
  const again = await hashFunnelVisitor("2026-10-22", "203.0.113.10", "Mozilla/5.0 Chrome", secret);
  const rotated = await hashFunnelVisitor("2026-10-22", "203.0.113.10", "Mozilla/5.0 Chrome", `${secret}-rotated`);
  assert.equal(first, again);
  assert.notEqual(first, rotated);
  const columns = psql("select column_name from information_schema.columns where table_name='zevanory_funnel_events' order by column_name");
  assert.doesNotMatch(columns, /^(email|phone|name|ip)$/m);
  assert.match(columns, /visitor_hash/);
});
