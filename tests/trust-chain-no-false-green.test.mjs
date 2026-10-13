// P0: the control panel must never show TRUST CHAIN GREEN without an independent quorum.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { legacyTrustProjection, guardTrustChain, quorumProven } from "../worker/trust-projection.mjs";

const allLegacyOk = {
  global_state: "operational_commercial_enabled",
  policy: { counts: { proven: 10 }, framework: "ZEA-10" },
  zea10_live: { ready: true, fail_closed: false },
  proof_chain: { sha: "abc123" },
};

test("legacy indicators alone never produce GREEN (they produce UNVERIFIED)", () => {
  const t = legacyTrustProjection(allLegacyOk);
  assert.notEqual(t.state, "GREEN");
  assert.equal(t.state, "UNVERIFIED");
  assert.equal(t.compatibility.quorum_available, false);
  assert.equal(quorumProven(t), false);
});

test("legacy projection is BLOCKED when indicators fail", () => {
  for (const patch of [{ global_state: "operational_commercial_blocked" }, { policy: { counts: { proven: 9 } } }, { zea10_live: { ready: true, fail_closed: true } }, { zea10_live: { ready: false } }]) {
    assert.equal(legacyTrustProjection({ ...allLegacyOk, ...patch }).state, "BLOCKED", JSON.stringify(patch));
  }
});

test("a canonical GREEN without a proven quorum is demoted; a proven one is kept", () => {
  const weak = [
    { state: "GREEN", passed: 0, total: 0, required: 0, independent_keys: 0, evidence_root: null },
    { state: "GREEN", passed: 1, total: 3, required: 2, independent_keys: 1, evidence_root: "r" },
    { state: "GREEN", passed: 3, total: 3, required: 2, independent_keys: 3, conflicts: 1, evidence_root: "r" },
    { state: "GREEN", passed: 3, total: 3, required: 2, independent_keys: 3, evidence_root: "" },
  ];
  for (const t of weak) assert.equal(guardTrustChain(t).state, "UNVERIFIED", JSON.stringify(t));
  const strong = { state: "GREEN", passed: 3, total: 3, required: 2, independent_keys: 3, conflicts: 0, evidence_root: "sha256:root" };
  assert.equal(guardTrustChain(strong).state, "GREEN");
  assert.equal(guardTrustChain({ state: "BLOCKED" }).state, "BLOCKED");
});

test("the worker routes every trust_chain through the guard", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  assert.match(src, /body\.trust_chain = body\.trust_chain \? guardTrustChain\(body\.trust_chain\) : legacyTrustProjection\(body\);/);
  assert.doesNotMatch(src, /function legacyTrustProjection/);
});
