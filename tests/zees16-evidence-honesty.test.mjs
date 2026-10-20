import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const wf = readFileSync(new URL("../.github/workflows/zees16-evidence-gate.yml", import.meta.url), "utf8");
const step = wf.slice(wf.indexOf("- name: Emit immutable ZEES gate evidence"), wf.indexOf("- uses: actions/upload-artifact@v4", wf.indexOf("- name: Emit immutable ZEES gate evidence")));

test("ZEES-16: a evidência não grava 'proved' fixo", () => {
  assert.doesNotMatch(step, /status:"proved"/);
  assert.match(step, /JOB_STATUS: \$\{\{ job\.status \}\}/);
});

test("ZEES-16: o passo real grava proved só com job success e failed nos demais casos", () => {
  const run = step.slice(step.indexOf("run: |") + 6).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  for (const [job, esperado] of [["success", "proved"], ["failure", "failed"], ["cancelled", "failed"], ["", "failed"]]) {
    const out = execFileSync("bash", ["-c", run + "\ncat p06-zees-gate.json"], { env: { ...process.env, JOB_STATUS: job, EXPECTED_SHA: "a".repeat(40), GITHUB_RUN_ID: "1" }, cwd: process.env.TMPDIR || "/tmp" }).toString();
    const ev = JSON.parse(out.slice(out.indexOf("{")));
    assert.equal(ev.status, esperado, job); assert.equal(ev.job_status, job);
  }
});
