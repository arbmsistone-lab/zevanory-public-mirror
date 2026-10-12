import test from "node:test";
import assert from "node:assert/strict";
import { computeAutonomy, computePublications, forecastSales, nextRun, recommend, metric, AGENDA } from "../scripts/audit/command-center-snapshot.mjs";

const now = Date.parse("2026-10-12T12:00:00Z");
const run = (path, event, conclusion, at) => ({ path: ".github/workflows/" + path, event, status: "completed", conclusion, created_at: at, updated_at: at });

test("autonomy counts recoveries, manual runs and MTTR from real runs", () => {
  const a = computeAutonomy([
    run("a.yml", "schedule", "success", "2026-10-11T10:00:00Z"),
    run("a.yml", "schedule", "failure", "2026-10-11T13:00:00Z"),
    run("a.yml", "schedule", "success", "2026-10-11T14:00:00Z"),
    run("b.yml", "schedule", "failure", "2026-10-11T15:00:00Z"),
    run("b.yml", "workflow_dispatch", "success", "2026-10-11T16:00:00Z"),
    run("a.yml", "schedule", "success", "2026-10-01T10:00:00Z"),
  ], now);
  assert.equal(a.scheduledRuns, 4); assert.equal(a.failed, 2); assert.equal(a.recoveredAutomatically, 1);
  assert.equal(a.unrecovered, 1); assert.equal(a.manualRuns, 1); assert.equal(a.mttrMinutes, 60);
  assert.equal(a.autonomyPct, 60); // (2 ok + 1 recovered) / (4 scheduled + 1 manual)
});

test("no runs means no autonomy number, never a fake 100%", () => {
  assert.equal(computeAutonomy([], now).autonomyPct, null);
});

test("publication completion only counts recorded slots", () => {
  const p = computePublications({ "2026-10-12": { telegram: { status: "publicado" }, bluesky: { status: "erro" } }, "2026-10-11": { youtube: { status: "publicado" } } });
  assert.deepEqual([p.expected, p.published, p.pct], [3, 2, 66.7]);
});

test("forecast refuses without history, gives an interval with it", () => {
  assert.equal(forecastSales({}, null, now).status, "insufficient");
  const byDay = {};
  for (let i = 0; i < 20; i++) byDay[new Date(now - i * 864e5).toISOString().slice(0, 10)] = { approved: i % 4 === 0 ? 1 : 0, grossCents: i % 4 === 0 ? 24700 : 0 };
  const f = forecastSales(byDay, "2026-09-22", now);
  assert.equal(f.status, "ok"); assert.ok(f.salesInterval80[0] <= f.salesExpected && f.salesExpected <= f.salesInterval80[1]);
});

test("next run respects hour and day-of-month", () => {
  assert.equal(nextRun({ m: 0, h: 13 }, now), "2026-10-12T13:00:00.000Z");
  assert.equal(nextRun({ m: 0, h: 9, dom: [1, 11, 21] }, now), "2026-10-21T09:00:00.000Z");
  assert.ok(AGENDA.every((a) => nextRun(a.cron, now)));
});

test("metrics without value are marked missing; recommendations carry evidence", () => {
  assert.equal(metric(null, "x", null, "d").integrity, "missing");
  const r = recommend({ funnel: { sources: { youtube: { views: 10, checkout_intent: 0 } } }, reach: null, sales: { totals: { approved: 0 } }, publications: { pct: 100 } });
  assert.ok(r.length >= 2 && r.every((x) => x.evidence && x.action && x.confidence));
});

import { classifyBuyPage } from "../scripts/audit/command-center-snapshot.mjs";
test("buy page classification reflects what the buyer sees", () => {
  assert.equal(classifyBuyPage(200, "<h1>Vendas abrem em breve</h1>"), "closed");
  assert.equal(classifyBuyPage(200, "<button>Ir para o pagamento seguro</button>"), "checkout");
  assert.equal(classifyBuyPage(503, ""), "error");
});
