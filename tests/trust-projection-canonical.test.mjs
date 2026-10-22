// Owner audit 13/10/2026, Mission 1: the /api/control-plane projection must read the canonical
// ZEA-10 evaluation (zea10_live.report) instead of the deprecated policy block, keep the
// UNVERIFIED ceiling of #792, and the vnext dialog must not invent quorum numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { legacyTrustProjection } from "../worker/trust-projection.mjs";
import { CONTROL_PLANE_VNEXT_JS } from "../worker/control-plane-vnext-source.mjs";

const SHA = "2cf3649dfa446f693f721f1cc9a2c9bc7cdaa085";
// Shape observed live on 13/10 ~13:05Z: deprecated policy 0/10, canonical evaluation 10/10.
const live = (over = {}) => ({
  global_state: "operational_commercial_enabled",
  release: { deployment: { commit_sha: SHA } },
  proof_chain: { sha: SHA },
  policy: { counts: { proven: 0, partial: 10, blocked: 0 }, deprecated_for_decision: true },
  zea10_live: { ready: true, fail_closed: false, report: { authority: true, release_sha: SHA, counts: { proven: 10, partial: 0, blocked: 0, unknown: 0 } } },
  ...over,
});

test("canonical 10/10 on the exact release => UNVERIFIED (not BLOCKED by the deprecated block, never GREEN)", () => {
  const t = legacyTrustProjection(live());
  assert.equal(t.state, "UNVERIFIED");
  assert.notEqual(t.state, "GREEN");
});

test("canonical evaluation incomplete, unbound or fail-closed => BLOCKED", () => {
  const z = live().zea10_live;
  const cases = [
    { zea10_live: { ...z, report: { ...z.report, counts: { proven: 9, partial: 1, blocked: 0, unknown: 0 } } } },
    { zea10_live: { ...z, report: { ...z.report, counts: { proven: 10, partial: 0, blocked: 0, unknown: 1 } } } },
    { zea10_live: { ...z, report: { ...z.report, release_sha: "1d40daa1fb5a15e042bed22d984cf6729782cf6c" } } },
    { zea10_live: { ...z, fail_closed: true } },
    { zea10_live: { ...z, ready: false } },
    { global_state: "operational_commercial_blocked" },
    { zea10_live: { ...z, report: { ...z.report, release_sha: undefined } } },
    { release: undefined, proof_chain: undefined },
  ];
  for (const patch of cases) assert.equal(legacyTrustProjection(live(patch)).state, "BLOCKED", JSON.stringify(patch));
});

test("SHA comparison is case-insensitive", () => {
  const z = live().zea10_live;
  assert.equal(legacyTrustProjection(live({ zea10_live: { ...z, report: { ...z.report, release_sha: SHA.toUpperCase() } } })).state, "UNVERIFIED");
});

test("vnext dialog does not default a missing quorum to 3 / minimum 2", () => {
  assert.doesNotMatch(CONTROL_PLANE_VNEXT_JS, /t\?\.total\|\|3|t\?\.required\|\|2/);
  assert.match(CONTROL_PLANE_VNEXT_JS, /SEM QUORUM INDEPENDENTE PROVADO/);
  assert.equal(readFileSync(new URL("../worker/live-recovered/control-plane-vnext.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"), CONTROL_PLANE_VNEXT_JS);
});
