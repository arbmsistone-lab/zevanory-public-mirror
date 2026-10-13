import test from "node:test";
import assert from "node:assert/strict";
import { kvPrefix, meterKv, withMeteredKv } from "../worker/kv-meter.mjs";

test("prefix keeps the stable head of a key, never ids or dates", () => {
  assert.equal(kvPrefix("zpc:cron:v1:hourly"), "zpc:cron:v1");
  assert.equal(kvPrefix("postsale:sent:3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90:d1"), "postsale:sent");
  assert.equal(kvPrefix("zpc:backup:v1:neon:2026-10-12:part:0"), "zpc:backup:v1");
  assert.equal(kvPrefix("whatsapp-e2e/1760000000000-x"), "whatsapp-e2e");
});

test("metered binding logs puts and deletes and still writes", async () => {
  const store = new Map(); const lines = [];
  const kv = { async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async get(k) { return store.get(k) ?? null; } };
  const env = withMeteredKv({ ZEVANORY_PRIVATE_ARTIFACTS: kv, OTHER: 1 }, "cron:hourly", (l) => lines.push(JSON.parse(l)));
  await env.ZEVANORY_PRIVATE_ARTIFACTS.put("zpc:cron:v1:hourly", "x");
  assert.equal(await env.ZEVANORY_PRIVATE_ARTIFACTS.get("zpc:cron:v1:hourly"), "x");
  await env.ZEVANORY_PRIVATE_ARTIFACTS.delete("zpc:cron:v1:hourly");
  assert.deepEqual(lines, [{ kvw: "zpc:cron:v1", op: "put", src: "cron:hourly" }, { kvw: "zpc:cron:v1", op: "delete", src: "cron:hourly" }]);
  assert.equal(env.OTHER, 1);
  assert.equal(meterKv(env.ZEVANORY_PRIVATE_ARTIFACTS, "x"), env.ZEVANORY_PRIVATE_ARTIFACTS, "never double-wrapped");
});

test("above 70% of the daily quota, observability writes are shed and critical ones still land", async () => {
  const store = new Map(); const lines = [];
  const day = "2026-10-13";
  store.set("zpc:kv:v1:budget", JSON.stringify({ day, pct: 82 }));
  const kv = { async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async get(k) { return store.get(k) ?? null; } };
  const memo = { at: 0, pct: null };
  const env = withMeteredKv({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, "cron:x", (l) => lines.push(JSON.parse(l)), { memo, now: () => Date.parse(day + "T12:00:00Z") });
  await env.ZEVANORY_PRIVATE_ARTIFACTS.put("zpc:cron:v1:hourly", "beat");
  await env.ZEVANORY_PRIVATE_ARTIFACTS.put("zpc:commercial:v1:financial-proof", "proof");
  assert.equal(store.has("zpc:cron:v1:hourly"), false, "heartbeat shed");
  assert.equal(store.get("zpc:commercial:v1:financial-proof"), "proof", "P0 write kept");
  assert.equal(lines[0].op, "shed:put");
});

test("a reading from a previous UTC day never sheds (quota already reset)", async () => {
  const store = new Map([["zpc:kv:v1:budget", JSON.stringify({ day: "2026-10-12", pct: 99 })]]);
  const kv = { async put(k, v) { store.set(k, v); }, async get(k) { return store.get(k) ?? null; } };
  const env = withMeteredKv({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, "cron:x", () => {}, { memo: { at: 0, pct: null }, now: () => Date.parse("2026-10-13T00:30:00Z") });
  await env.ZEVANORY_PRIVATE_ARTIFACTS.put("zpc:cron:v1:hourly", "beat");
  assert.equal(store.get("zpc:cron:v1:hourly"), "beat");
});

import { putBeat } from "../worker/kv-meter.mjs";
test("heartbeats are not rewritten when nothing changed within 50 minutes", async () => {
  const store = new Map(); let puts = 0;
  const kv = { async put(k, v) { puts++; store.set(k, v); }, async get(k) { return store.get(k) ?? null; } };
  const t0 = Date.parse("2026-10-13T04:15:00Z");
  assert.equal(await putBeat(kv, "zpc:cron:v1:isolated", { tasks: { financial_proof: "ok" } }, { now: t0 }), "written");
  assert.equal(await putBeat(kv, "zpc:cron:v1:isolated", { tasks: { financial_proof: "ok" } }, { now: t0 + 30 * 60e3 }), "unchanged");
  assert.equal(await putBeat(kv, "zpc:cron:v1:isolated", { tasks: { financial_proof: "fail:x" } }, { now: t0 + 31 * 60e3 }), "written", "a change is written at once");
  assert.equal(await putBeat(kv, "zpc:cron:v1:isolated", { tasks: { financial_proof: "fail:x" } }, { now: t0 + 90 * 60e3 }), "written", "refreshed after 50 min");
  assert.equal(puts, 3);
});
