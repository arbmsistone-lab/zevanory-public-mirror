import test from "node:test";
import assert from "node:assert/strict";
import { classifyWorkflow, classifyProcess, summarize } from "../scripts/audit/system-matrix.mjs";
const now = Date.parse("2026-10-12T12:00:00Z");
const r = (conclusion, at = "2026-10-12T10:00:00Z") => ({ status: "completed", conclusion, created_at: at, updated_at: at });

test("no run is NOT_TESTED, never PASS; failure is FAIL; disabled is BLOCKED; stale is NOT_TESTED", () => {
  assert.equal(classifyWorkflow({ state: "active" }, [], now).state, "NOT_TESTED");
  assert.equal(classifyWorkflow({ state: "active" }, [r("failure")], now).state, "FAIL");
  assert.equal(classifyWorkflow({ state: "active" }, [r("cancelled"), r("success")], now).state, "PASS");
  assert.equal(classifyWorkflow({ state: "disabled_manually" }, [r("success")], now).state, "BLOCKED");
  assert.equal(classifyWorkflow({ state: "active" }, [r("success", "2026-08-01T00:00:00Z")], now).state, "NOT_TESTED");
});

test("processes: proven PASS, third party BLOCKED externo, owner-reserved excluded", () => {
  assert.equal(classifyProcess({ eligible: true, proven: true }).state, "PASS");
  assert.equal(classifyProcess({ eligible: true, proven: false, state: "blocked_third_party" }).owner, "externo");
  assert.equal(classifyProcess({ eligible: false }), null);
  const s = summarize([{ id: "a", state: "PASS" }, { id: "b", state: "FAIL" }]);
  assert.equal(s.items[0].state, "FAIL"); assert.equal(s.passPct, 50);
});

import { readFileSync } from "node:fs";
test("retirement list never contains security, financial-gate or quality gates", () => {
  const list = JSON.parse(readFileSync(new URL("../data/retired-workflows.json", import.meta.url))).retired;
  const forbidden = /secret|gitleaks|sast|security|p07|p08|ped|mercadopago-(reconcil|webhook)|refund|checkout|deploy|reconciler|matrix|command-center|engine-dispatcher|zees16-control/i;
  for (const r of list) assert.ok(!forbidden.test(r.file), r.file);
  assert.ok(list.every((r) => r.reason && r.since));
});

test("owner-gated proofs: every entry names a gate that really exists in the workflow file", () => {
  const list = JSON.parse(readFileSync(new URL("../data/retired-workflows.json", import.meta.url))).ownerGated || [];
  assert.ok(list.length > 0);
  for (const g of list) {
    const src = readFileSync(new URL("../.github/workflows/" + g.file, import.meta.url), "utf8");
    assert.ok(src.includes(g.gate), g.file + " lost its gate");
    assert.ok(g.reason && g.reason.length > 20);
  }
});

test("a routine whose recent runs were cancelled by concurrency is judged by its last completed run", () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => ({ status: "completed", conclusion: "cancelled", created_at: "2026-10-12T23:0" + i + ":00Z" })),
    { status: "completed", conclusion: "success", created_at: "2026-10-12T22:50:00Z", updated_at: "2026-10-12T22:51:00Z" },
  ];
  assert.equal(classifyWorkflow({ state: "active" }, runs, Date.parse("2026-10-12T23:10:00Z")).state, "PASS");
});
