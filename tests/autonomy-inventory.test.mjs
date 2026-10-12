import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateInventory } from "../scripts/audit/autonomy-inventory.mjs";
const inv = JSON.parse(readFileSync(new URL("../data/process-inventory.json", import.meta.url)));
const now = Date.parse("2026-10-13T12:00:00Z");

test("without evidence nothing counts as autonomous", () => {
  const r = evaluateInventory(inv, {}, now);
  assert.equal(r.provenAutonomous, 0); assert.equal(r.pct, 0);
  assert.ok(r.eligible > 0 && r.ownerReserved.length >= 5);
});

test("fresh evidence proves, stale does not; reserved acts never enter the denominator", () => {
  const ctx = {
    byDay: { "2026-10-13": { telegram: { status: "publicado", at: "2026-10-13T10:00:00Z" }, blog: { status: "publicado", at: "2026-10-11T10:00:00Z" } } },
    runs: [{ path: ".github/workflows/indexnow-submit.yml", event: "schedule", conclusion: "success", created_at: "2026-10-13T09:40:00Z" }, { path: ".github/workflows/indexnow-submit.yml", event: "workflow_dispatch", conclusion: "success", created_at: "2026-10-13T11:00:00Z" }],
    funnelAt: "2026-10-13T11:30:00Z",
    buyFlow: [{ state: "checkout" }], hotmart: [{ http: 200, blockedText: false }], probes: [{ ok: true }],
  };
  const r = evaluateInventory(inv, ctx, now);
  const p = Object.fromEntries(r.processes.map((x) => [x.id, x]));
  assert.equal(p.telegram.proven, true); assert.equal(p.blog.proven, false);
  assert.equal(p.indexnow.proven, true); assert.equal(p.funnel.proven, true);
  assert.equal(p.contracts.eligible, false);
  assert.equal(r.eligible, inv.processes.filter((x) => x.eligible).length);
  assert.equal(r.dependencies[0].impact, "high");
});
