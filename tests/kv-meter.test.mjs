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
