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
  assert.equal(p.indexnow.proven, true); assert.equal(p.funnel.proven, false); // funnel needs the server heartbeat now
  assert.equal(p.contracts.eligible, false);
  assert.equal(r.eligible, inv.processes.filter((x) => x.eligible).length);
  assert.equal(r.dependencies[0].impact, "high");
});

test("dispatcher (workflow_run), panel live proof and backup prove only with a successful autonomous run", () => {
  const run = (path, event, conclusion, actor = null) => ({ path, event, actor, conclusion, created_at: "2026-10-13T11:00:00Z" });
  const ctx = { runs: [
    run(".github/workflows/engine-dispatcher.yml", "workflow_run", "success"),
    run("panel:.github/workflows/command-center-live-proof.yml", "schedule", "failure"),
    run(".github/workflows/data-backup.yml", "workflow_dispatch", "success", "renan-human"),
  ] };
  const p = Object.fromEntries(evaluateInventory(inv, ctx, now).processes.map((x) => [x.id, x]));
  assert.equal(p.dispatcher.proven, true);
  assert.equal(p["live-proof"].proven, false); // a failed proof never counts
  assert.equal(p.backup.proven, false); // a manual run is not autonomy
  const ok = evaluateInventory(inv, { runs: [run("panel:.github/workflows/command-center-live-proof.yml", "schedule", "success")], backup: { ok: true, finishedAt: "2026-10-13T05:10:00Z", restore: { neon: { ok: 9 }, kv: { verified: 40 } } } }, now);
  const q = Object.fromEntries(ok.processes.map((x) => [x.id, x]));
  assert.equal(q.backup.proven, true); assert.equal(q["live-proof"].proven, true);
  const bad = evaluateInventory(inv, { backup: { ok: false, finishedAt: "2026-10-13T05:10:00Z" } }, now);
  assert.equal(bad.processes.find((x) => x.id === "backup").proven, false); // a backup whose restore did not match never counts
});

test("voice attendant counts only with a fresh, fully passing end-to-end evaluation", () => {
  const at = "2026-10-12T09:00:00Z";
  const pv = (v) => evaluateInventory(inv, { voiceEval: v }, now).processes.find((x) => x.id === "support-voice");
  assert.equal(pv({ ok: true, generatedAt: at, scorePct: 100, fallback: { ok: true } }).proven, true);
  assert.equal(pv({ ok: false, generatedAt: at, scorePct: 66.7, fallback: { ok: true } }).proven, false);
  assert.equal(pv({ ok: true, generatedAt: "2026-10-01T09:00:00Z" }).proven, false);
  assert.equal(pv(null).proven, false);
});

test("hourly heartbeat proves funnel and nurture; a failing task is FAIL, not 'not tested'", async () => {
  const { classifyProcess } = await import("../scripts/audit/system-matrix.mjs");
  const beat = (tasks, at = "2026-10-13T11:20:00Z") => ({ cronBeat: { finishedAt: at, tasks } });
  const get = (ctx, id) => evaluateInventory(inv, ctx, now).processes.find((x) => x.id === id);
  assert.equal(get(beat({ funnel: "ok", nurture: "ok" }), "funnel").proven, true);
  const bad = get(beat({ funnel: "fail:too many subrequests", nurture: "ok" }), "funnel");
  assert.equal(bad.proven, false); assert.equal(bad.failed, true);
  assert.equal(classifyProcess(bad).state, "FAIL");
  assert.equal(get(beat({ funnel: "ok" }, "2026-10-13T06:00:00Z"), "funnel").proven, false); // stale heartbeat
  const delivery = get({}, "delivery");
  assert.equal(delivery.state, "awaiting_event"); assert.equal(classifyProcess(delivery).state, "BLOCKED");
  const voice = get({ voiceEval: { ok: false, generatedAt: "2026-10-12T15:00:00Z", scorePct: 0 } }, "support-voice");
  assert.equal(classifyProcess(voice).state, "FAIL");
});

test("funnel proof comes from whichever server cycle ran it most recently", () => {
  const p = evaluateInventory(inv, { cronBeats: [
    { finishedAt: "2026-10-13T11:00:00Z", tasks: { nurture: "ok" } },
    { finishedAt: "2026-10-13T11:15:00Z", tasks: { funnel: "ok" } },
  ] }, now).processes;
  assert.equal(p.find((x) => x.id === "funnel").proven, true);
  assert.equal(p.find((x) => x.id === "nurture").proven, true);
});
