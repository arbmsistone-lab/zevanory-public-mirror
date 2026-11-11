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
    byDay: { "2026-10-13": { bluesky: { status: "publicado", at: "2026-10-13T10:00:00Z" }, blog: { status: "publicado", at: "2026-10-11T10:00:00Z" } } },
    runs: [{ path: ".github/workflows/indexnow-submit.yml", event: "schedule", conclusion: "success", created_at: "2026-10-13T09:40:00Z" }, { path: ".github/workflows/indexnow-submit.yml", event: "workflow_dispatch", conclusion: "success", created_at: "2026-10-13T11:00:00Z" }],
    funnelAt: "2026-10-13T11:30:00Z",
    buyFlow: [{ state: "checkout" }], hotmart: [{ http: 200, blockedText: false }], probes: [{ ok: true }],
  };
  const r = evaluateInventory(inv, ctx, now);
  const p = Object.fromEntries(r.processes.map((x) => [x.id, x]));
  assert.equal(p.bluesky.proven, true); assert.equal(p.blog.proven, false);
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

test("F1: falha registrada do Bluesky aparece como \"bluesky erro: <motivo>\" e marca o processo como falho", () => {
  const ctx = { byDay: { "2026-10-13": { bluesky: { status: "erro", code: "similarity", at: "2026-10-13T11:00:00Z" } }, "2026-10-12": { bluesky: { status: "publicado", at: "2026-10-11T22:00:00Z" } } } };
  const p = Object.fromEntries(evaluateInventory(inv, ctx, now).processes.map((x) => [x.id, x]));
  assert.equal(p.bluesky.proven, false); assert.equal(p.bluesky.failed, true);
  assert.equal(p.bluesky.how, "bluesky erro: similarity");
  // Publicação mais nova que o erro prova o processo e não marca falha.
  const ok = { byDay: { ...ctx.byDay, "2026-10-13": { bluesky: { status: "publicado", at: "2026-10-13T11:30:00Z" } } } };
  const q = Object.fromEntries(evaluateInventory(inv, ok, now).processes.map((x) => [x.id, x]));
  assert.equal(q.bluesky.proven, true); assert.equal(q.bluesky.failed, false); assert.equal(q.bluesky.how, "publicação confirmada pelo provedor");
  // Erro antigo (fora da janela) não acusa falha.
  const stale = { byDay: { "2026-10-10": { bluesky: { status: "erro", code: "similarity", at: "2026-10-10T11:00:00Z" } } } };
  assert.equal(evaluateInventory(inv, stale, now).processes.find((x) => x.id === "bluesky").failed, false);
});

test("F0 nº 7: Telegram de divulgação fora do denominador (desligado por decisão do proprietário)", () => {
  const t = inv.processes.find((x) => x.id === "telegram");
  assert.deepEqual([t.eligible, t.state, t.note], [false, "desligado", "Decisão F0 nº 7 do proprietário (10/11/2026)"]);
  const r = evaluateInventory(inv, { byDay: { "2026-10-13": { telegram: { status: "publicado", at: "2026-10-13T10:00:00Z" } } } }, now);
  const p = r.processes.find((x) => x.id === "telegram");
  assert.equal(p.eligible, false); assert.equal(p.proven, false);
  assert.equal(r.dependencies.some((d) => d.id === "telegram"), false);
});
