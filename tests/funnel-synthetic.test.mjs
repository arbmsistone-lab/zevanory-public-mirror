import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FUNNEL_EVENT_NAMES,
  emitFunnelEvent,
  validateFunnelEvent,
} from "../worker/funnel-events.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/funnel-event.v1.schema.json", import.meta.url)));
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130";
const BOT = "Googlebot/2.1";
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function event(name, index, extra = {}) {
  return {
    event_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    version: "1.0.0",
    name,
    occurred_at: new Date(NOW + index).toISOString(),
    page: "ia-na-pratica",
    product: "ia-na-pratica",
    ...extra,
  };
}

function memoryStore() {
  const events = new Map();
  const metrics = Object.create(null);
  return {
    events,
    metrics,
    async hasEvent(id) { return events.has(id); },
    async latestEvent(hash, testMode) {
      return [...events.values()].reverse()
        .find((entry) => entry.visitorHash === hash && entry.testMode === testMode)?.event || null;
    },
    async insertEvent(value, visitorHash, testMode) {
      if (events.has(value.event_id)) return false;
      events.set(value.event_id, { event: value, visitorHash, testMode });
      return true;
    },
    async incrementMetric(value) { metrics[value.name] = (metrics[value.name] || 0) + 1; },
  };
}

const emit = (store, value, visitorHash, options = {}) => emitFunnelEvent(value, {
  store, visitorHash, userAgent: HUMAN, hasJavaScript: true, now: NOW + 1000,
  production: false, salesOpen: false, testMode: true, ...options,
});

test("synthetic human funnel is counted while known bot traffic is excluded", async () => {
  const store = memoryStore();
  const humanHash = "a".repeat(64);
  const botHash = "b".repeat(64);
  for (const [index, name] of FUNNEL_EVENT_NAMES.entries()) {
    const accepted = await emit(store, event(name, index + 1), humanHash);
    assert.equal(accepted.accepted, true, name);
    const automated = await emit(store, event(name, index + 101), botHash, { userAgent: BOT });
    assert.equal(automated.accepted, false, name);
  }
  assert.equal(store.events.size, 6);
  assert.deepEqual([...store.events.values()].map(({ event: item }) => item.name), [...FUNNEL_EVENT_NAMES]);
  assert.deepEqual({ ...store.metrics }, Object.fromEntries(FUNNEL_EVENT_NAMES.map((name) => [name, 1])));
});

test("versioned JSON Schema and validator require a supported event version", () => {
  assert.equal(schema.properties.version.const, "1.0.0");
  assert.ok(schema.required.includes("version"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(validateFunnelEvent(event("visit", 2)), true);
  assert.equal(validateFunnelEvent(event("visit", 3, { version: undefined })), false);
});

test("event schema rejects PII and unknown fields", () => {
  assert.equal(validateFunnelEvent(event("lead", 4, { email: "pessoa@example.com" })), false);
  assert.equal(validateFunnelEvent(event("lead", 5, { source: "pessoa@example.com" })), false);
});

test("duplicate event identifiers increment the metric only once", async () => {
  const store = memoryStore();
  const value = event("visit", 6);
  const productionLike = { salesOpen: true, testMode: false };
  assert.equal((await emit(store, value, "c".repeat(64), productionLike)).accepted, true);
  assert.deepEqual(await emit(store, value, "c".repeat(64), productionLike), { accepted: false, reason: "duplicate" });
  assert.equal(store.events.size, 1);
  assert.equal(store.metrics.visit, 1);
});

test("out-of-order funnel stages are rejected", async () => {
  const store = memoryStore();
  const result = await emit(store, event("checkout_started", 7), "d".repeat(64));
  assert.deepEqual(result, { accepted: false, reason: "invalid_order" });
  assert.equal(store.events.size, 0);
});

test("traffic without JavaScript and anomalous event rates are rejected", async () => {
  const store = memoryStore();
  const hash = "e".repeat(64);
  assert.deepEqual(await emit(store, event("visit", 8), hash, { hasJavaScript: false }), {
    accepted: false, reason: "automated_or_no_js",
  });
  let last;
  for (let index = 0; index < 21; index += 1) {
    last = await emit(store, event("visit", index + 20), hash);
  }
  assert.deepEqual(last, { accepted: false, reason: "rate_limited" });
  assert.equal(store.events.size, 20);
});

test("production checkout and payment events stay disabled while sales are closed", async () => {
  const store = memoryStore();
  const result = await emit(store, event("checkout_started", 50), "f".repeat(64), {
    production: true, salesOpen: false, testMode: false,
  });
  assert.deepEqual(result, { accepted: false, reason: "sales_closed" });
  assert.equal(store.events.size, 0);
});
