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


test("production staging: core never substitutes stale KV SHA after internal control-plane 503", async () => {
  const { buildCoreSnapshot, evaluateCoreDecision } = await import("../worker/zevanory-control-core.mjs");
  const sha = "b".repeat(40);
  const stale = "a".repeat(40);
  const now = new Date().toISOString();
  const state = { release_sha: stale, observed_at: now, counts: { proven: 16, partial: 0, blocked: 0 }, persistence: "kv-append-only" };
  const env = {
    ZEVANORY_RELEASE_SHA: sha, MERCADOPAGO_ENV: "production",
    ABSOLUTE_RELEASE_APPROVED: "true", PRE_SALE_GATES_APPROVED: "true",
    MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: "384d9fe762bbdf9b",
    SALE_GLOBALLY_ENABLED: "false", WHATSAPP_SALES_ENABLED: "false",
    ZEVANORY_PRIVATE_ARTIFACTS: { get: async key => key === "control:v2:state:zevanory" ? JSON.stringify(state) : null }
  };
  const worker = { fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/api/control-plane") return new Response(JSON.stringify({error:"internal_control_unavailable"}), { status: 503 });
    if (path === "/api/health") return Response.json({ ready: true, live: true });
    if (path === "/api/continuity") return Response.json({ quorum_ok: true });
    return Response.json({ runtime: { sales: "globally-blocked" } });
  }};
  const snapshot = await buildCoreSnapshot(worker, env, {}, "https://zevanory.api.br");
  assert.equal(snapshot.release_sha, sha);
  assert.equal(snapshot.zees16, null);
  assert.equal(snapshot.invariants.control_plane_ready, false);
  assert.equal(evaluateCoreDecision(snapshot).decision, "DENY");
});

test("production staging: an upstream SHA mismatch never overrides build identity", async () => {
  const { buildCoreSnapshot, evaluateCoreDecision } = await import("../worker/zevanory-control-core.mjs");
  const sha = "b".repeat(40), old = "a".repeat(40);
  const env = { ZEVANORY_RELEASE_SHA: sha, ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => null } };
  const worker = { fetch: async request => {
    const path = new URL(request.url).pathname;
    if(path === "/api/control-plane") return Response.json({ release: {deployment: {commit_sha:old}} });
    if(path === "/api/health") return Response.json({ready:true,live:true});
    if(path === "/api/continuity") return Response.json({quorum_ok:true});
    return Response.json({runtime:{sales:"globally-blocked"}});
  }};
  const snapshot = await buildCoreSnapshot(worker,env,{},"https://zevanory.api.br");
  assert.equal(snapshot.release_sha,sha);
  assert.equal(snapshot.invariants.exact_release_bound,false);
  assert.equal(evaluateCoreDecision(snapshot).decision,"DENY");
});
