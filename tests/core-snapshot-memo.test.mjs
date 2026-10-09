import test from "node:test";
import assert from "node:assert/strict";
import { buildCoreSnapshotCached, resetCoreSnapshotMemo } from "../worker/zevanory-control-core.mjs";

// Fake worker: counts how many times internal routes are computed.
function fakeWorker() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async fetch(req) { calls++; return new Response(JSON.stringify({ release: { deployment: { commit_sha: "a".repeat(40) } } }), { headers: { "content-type": "application/json" } }); }
  };
}
const env = { ZEVANORY_RELEASE_SHA: "a".repeat(40) };

test("burst of read-only polls shares one snapshot build within 20 s", async () => {
  resetCoreSnapshotMemo();
  const w = fakeWorker();
  const t0 = 1_000_000;
  const results = await Promise.all(Array.from({ length: 50 }, () => buildCoreSnapshotCached(w, env, {}, "https://zevanory.api.br", { now: t0 })));
  const perBuild = w.calls;
  assert.ok(perBuild > 0);
  assert.equal(new Set(results).size, 1);
  await buildCoreSnapshotCached(w, env, {}, "https://zevanory.api.br", { now: t0 + 19_000 });
  assert.equal(w.calls, perBuild, "no rebuild inside the 20 s window");
  await buildCoreSnapshotCached(w, env, {}, "https://zevanory.api.br", { now: t0 + 20_001 });
  assert.equal(w.calls, perBuild * 2, "rebuild after the window");
});

test("a new release never reuses a snapshot from the previous release", async () => {
  resetCoreSnapshotMemo();
  const w = fakeWorker();
  await buildCoreSnapshotCached(w, env, {}, "https://zevanory.api.br", { now: 1 });
  const n = w.calls;
  await buildCoreSnapshotCached(w, { ZEVANORY_RELEASE_SHA: "b".repeat(40) }, {}, "https://zevanory.api.br", { now: 2 });
  assert.equal(w.calls, n * 2);
});
