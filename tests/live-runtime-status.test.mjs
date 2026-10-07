import test from "node:test";
import assert from "node:assert/strict";
import { buildContinuityPlan } from "../worker/continuity-router.mjs";
import { projectLiveStatus, projectLocalZea10, whatsappTransportIsOperational } from "../worker/live-runtime-status.mjs";
import { readSalesSwitch, resetSalesSwitchCache } from "../worker/sales-control.mjs";
import { evaluatePolicy } from "../worker/evidence-control-plane.mjs";

function kv(entries) {
  const values = new Map(entries);
  return { get: async (key) => values.get(key) ?? null };
}

test("fresh green preflight and open owner switch never project globally-blocked", async () => {
  resetSalesSwitchCache();
  const now = Date.now();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv([
    ["sales:open:v1", JSON.stringify({ enabled: true, at: new Date(now).toISOString(), by: "owner" })],
    ["zpc-sales-preflight:v1", JSON.stringify({ ok: true, at: new Date(now - 60_000).toISOString() })],
  ]) };
  const salesSwitch = await readSalesSwitch(env, now);
  const transport = whatsappTransportIsOperational({}, { identity_verified: true, access_token: "token", phone_number_id: "phone" }, {});
  const status = projectLiveStatus({
    runtime: { telemetry: "active", sales: "globally-blocked", whatsapp: "disabled" },
    channel_readiness: {
      zevanory: { commercial: true, release_gate: "globally-blocked" },
      whatsapp: { commercial: true, release_gate: "globally-blocked", scope_status: "active" },
    },
  }, { salesOpen: salesSwitch.enabled, whatsappTransportOperational: transport });
  status.continuity = buildContinuityPlan(status, { minQuorum: 1 });
  assert.equal(status.runtime.sales, "enabled");
  assert.equal(status.runtime.whatsapp, "enabled");
  assert.equal(status.continuity.sales_state, "enabled");
  assert.equal(status.continuity.whatsapp_commercial_operational, true);
  assert.ok(Object.values(status.channel_readiness).every((item) => item.release_gate === "enabled"));
  assert.doesNotMatch(JSON.stringify(status), /globally-blocked/);
});

test("stale preflight remains fail closed", async () => {
  resetSalesSwitchCache();
  const now = Date.now();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv([
    ["sales:open:v1", JSON.stringify({ enabled: true })],
    ["zpc-sales-preflight:v1", JSON.stringify({ ok: true, at: new Date(now - 4 * 3600_000).toISOString() })],
  ]) };
  const salesSwitch = await readSalesSwitch(env, now);
  const status = projectLiveStatus({ runtime: {}, channel_readiness: {} }, { salesOpen: salesSwitch.enabled });
  assert.equal(salesSwitch.blocked, "preflight_not_green");
  assert.equal(status.runtime.sales, "globally-blocked");
});

test("central candidate preserves SELF without the incompatible ZEA10 RPC binding", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../scripts/deploy/prepare-central-candidate.py", import.meta.url), "utf8");
  assert.match(source, /\{"binding":"SELF","service":"zevanory"\}/);
  assert.doesNotMatch(source, /\{"binding":"ZEA10_ENGINE"/);
});

test("local ZEA10 projection is exact-release bound and fail closed", () => {
  const state = { release_sha: "a".repeat(40), observed_at: "2026-10-07T19:00:00.000Z", pillars: [] };
  const exact = projectLocalZea10(state, state.release_sha);
  assert.equal(exact.ready, true);
  assert.equal(exact.fail_closed, true);
  assert.equal(exact.source, "local_control_core");
  const stale = projectLocalZea10(state, "b".repeat(40));
  assert.equal(stale.ready, false);
  assert.equal(stale.fail_closed, true);
});

test("commercial evidence remains strict for both safe closed and healthy open states", () => {
  const workflows = new Map([["zevanory-p16-deterministic-exact-release", { conclusion: "success", id: 1 }]]);
  const closed = evaluatePolicy({ signals: {
    "runtime:sales_fail_closed": true,
    "runtime:health_ready": true,
  }, workflows });
  assert.equal(closed.pillars.find((pillar) => pillar.id === "P16").state, "PROVADO");

  const open = evaluatePolicy({ signals: {
    "runtime:commercial_release": true,
    "runtime:health_ready": true,
  }, workflows });
  assert.equal(open.pillars.find((pillar) => pillar.id === "P16").state, "PROVADO");

  const unhealthyOpen = evaluatePolicy({ signals: {
    "runtime:commercial_release": true,
    "runtime:health_ready": false,
  }, workflows });
  assert.notEqual(unhealthyOpen.pillars.find((pillar) => pillar.id === "P16").state, "PROVADO");
});
