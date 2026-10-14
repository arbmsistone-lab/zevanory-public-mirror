import test from "node:test";
import assert from "node:assert/strict";
import { decide, run, issueTitle } from "../scripts/audit/kv-quota-issue.mjs";

const F = { day: "2026-10-14", level: "early", writes: 610, limit: 1000, pct: 61, projectedEndOfDay: 820, projectedPct: 82 };

test("decide: skip when ok/absent, create once per day, update the same day's open issue", () => {
  assert.equal(decide(null, []).action, "skip");
  assert.equal(decide({ ...F, level: "ok" }, []).action, "skip");
  assert.equal(decide({ ...F, day: "bad" }, []).action, "skip");
  assert.deepEqual(decide(F, []), { action: "create", title: issueTitle("2026-10-14") });
  assert.deepEqual(decide(F, [{ number: 7, title: issueTitle("2026-10-14") }]), { action: "update", number: 7, title: issueTitle("2026-10-14") });
  assert.equal(decide(F, [{ number: 6, title: issueTitle("2026-10-13") }]).action, "create", "yesterday's issue is not reused");
  assert.equal(decide(F, [{ number: 8, title: issueTitle("2026-10-14"), pull_request: {} }]).action, "create", "PRs are not issues");
});

function harness(responses) {
  const calls = [], logs = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url, method: init.method || "GET", body: init.body }); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  const env = { KV_FORECAST_OUT: "/f.json", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" };
  return { calls, logs, go: (forecast) => run({ env, fetchImpl, log: (l) => logs.push(l), readFile: () => JSON.stringify(forecast) }) };
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status });

test("run: creates on first alert of the day, then updates (dedup), never throws", async () => {
  let h = harness([json([]), json({ number: 1 }, 201)]);
  assert.equal(await h.go(F), "create");
  assert.equal(h.calls[1].method, "POST"); assert.match(h.calls[1].body, /cota de gravações em risco — 2026-10-14/);
  h = harness([json([{ number: 1, title: issueTitle("2026-10-14") }]), json({ number: 1 })]);
  assert.equal(await h.go(F), "update");
  assert.equal(h.calls[1].method, "PATCH"); assert.match(h.calls[1].url, /\/issues\/1$/);
});

test("run: failures become a warning and exit cleanly (no exception, no retry storm)", async () => {
  for (const responses of [[new Error("network")], [json({}, 403)], [json([]), json({}, 422)]]) {
    const h = harness(responses);
    assert.equal(await h.go(F), "error");
    assert.ok(h.logs.some((l) => l.startsWith("::warning title=KV_QUOTA_ISSUE::")));
    assert.ok(h.calls.length <= 2);
  }
  const h = harness([]);
  assert.equal(await run({ env: { KV_FORECAST_OUT: "/missing" }, fetchImpl: async () => { throw new Error("must not call"); }, log: () => {}, readFile: () => { throw new Error("ENOENT"); } }), "skip");
  assert.equal(await h.go({ ...F, level: "ok" }), "skip"); assert.equal(h.calls.length, 0);
});

import { readFileSync } from "node:fs";
test("workflow contract: the notify step receives GITHUB_TOKEN from the job env and runs even if the snapshot failed", () => {
  const wf = readFileSync(new URL("../.github/workflows/command-center-snapshot.yml", import.meta.url), "utf8");
  assert.match(wf, /\n {2}issues: write\n/, "minimal permission present");
  // Job-level env applies to every step (GitHub Actions merges step env over job env, it never replaces it).
  assert.match(wf, /\n {4}env:\n {6}GITHUB_TOKEN: \$\{\{ github\.token \}\}\n/, "job env injects the workflow token");
  const step = wf.slice(wf.indexOf("- name: Notify owner when the KV write quota"));
  assert.match(step, /if: always\(\)/);
  assert.match(step, /run: node scripts\/audit\/kv-quota-issue\.mjs/);
  assert.doesNotMatch(step.split("\n      - name:")[0], /GITHUB_TOKEN:/, "the step does not override/blank the token");
});
test("run: without a token it warns and returns, never throws", async () => {
  const logs = [];
  const r = await run({ env: { KV_FORECAST_OUT: "/f", GITHUB_REPOSITORY: "o/r" }, fetchImpl: async () => { throw new Error("must not call"); }, log: (l) => logs.push(l), readFile: () => JSON.stringify(F) });
  assert.equal(r, "error"); assert.match(logs[0], /::warning title=KV_QUOTA_ISSUE::missing repository or token/);
});
