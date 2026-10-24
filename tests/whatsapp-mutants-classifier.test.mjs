// Meta-tests for the WhatsApp retirement mutant runner on the SHARED classifier (scripts/ci/mutant_classifier.py, PR
// #901; Sol audits 128/131). Synthetic TAP in the real node:test shape goes through the classifier CLI exactly as the
// runner sends it. Must show INCONCLUSIVE for a failure only in a secondary assertion, for an unrelated failure and for
// a primary test failing on a different assertion (label checked inside the not-ok block), and that an unjustified
// secondary or a primary without assertion_pattern makes the runner refuse to start (exit 4) before any suite runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const CLI = join(ROOT, "scripts/ci/mutant_classifier.py");
const CONFIG = join(ROOT, "scripts/ci/mutants_whatsapp_retirement.expected.json");
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };

const ok = (i, n) => `# Subtest: ${n}\nok ${i} - ${n}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n`;
const fail = (i, n, msg) => `# Subtest: ${n}\nnot ok ${i} - ${n}\n  ---\n  duration_ms: 1\n  type: 'test'\n  location: '/t.mjs:1:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    ${msg}\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: true\n  actual: false\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///t.mjs:1:1)\n  ...\n`;
const NAMES = ["kill-switch: rule", "retired: no fetch", "status surfaces: modes", "projection: runtime"];
function tap(failures) {
  let body = "TAP version 13\n", n = 0;
  NAMES.forEach((name, i) => { if (failures[name]) { n++; body += fail(i + 1, name, failures[name]); } else body += ok(i + 1, name); });
  return body + `1..4\n# tests 4\n# suites 0\n# pass ${4 - n}\n# fail ${n}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n`;
}
const SPEC = {
  primary: [{ test_pattern: "kill-switch:", assertion_pattern: "WR-SW-ENV" }],
  secondary: [{ test_pattern: "retired: no fetch", assertion_pattern: null, justification: "the env-honouring switch reopens this path, so its retired-only assertion fails" }],
};
function verdict(failures, spec = SPEC) {
  requireTool(PYTHON);
  const dir = mkdtempSync(join(tmpdir(), "zev-wa-cls-"));
  try {
    writeFileSync(join(dir, "t.tap"), tap(failures)); writeFileSync(join(dir, "e.json"), JSON.stringify(spec));
    const r = spawnSync(PYTHON, ["-B", CLI, "classify", "--baseline-total", "4", "--rc", Object.keys(failures).length ? "1" : "0", "--tap", join(dir, "t.tap"), "--expected", "@" + join(dir, "e.json"), "--mutant-id", "MX"], { encoding: "utf8", env, windowsHide: true });
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("shared classifier: labelled primary inside the block is KILLED; clean run is SURVIVED", () => {
  assert.equal(verdict({ "kill-switch: rule": "[WR-SW-ENV] false" }).verdict, "KILLED");
  assert.equal(verdict({ "kill-switch: rule": "[WR-SW-ENV] false", "retired: no fetch": "/api/status called the broker binding" }).verdict, "KILLED");
  assert.equal(verdict({}).verdict, "SURVIVED");
});

test("shared classifier: a failure ONLY in a secondary assertion is INCONCLUSIVE", () => {
  const v = verdict({ "retired: no fetch": "/api/status called the broker binding" });
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.match(v.reason, /only_secondary_failures/);
});

test("shared classifier: an unrelated failure, or the primary test failing on another assertion, is INCONCLUSIVE", () => {
  assert.equal(verdict({ "kill-switch: rule": "[WR-SW-ENV] false", "projection: runtime": "[WR-PROJ] runtime.whatsapp" }).verdict, "INCONCLUSIVE");
  assert.equal(verdict({ "projection: runtime": "[WR-PROJ] runtime.whatsapp" }).verdict, "INCONCLUSIVE");
  assert.equal(verdict({ "kill-switch: rule": "[WR-SW-CONST] retirement constant" }).verdict, "INCONCLUSIVE", "primary test, wrong assertion");
  assert.equal(verdict({ "kill-switch: rule": "[WR-SW-ENVX] other" }).verdict, "INCONCLUSIVE", "label boundary: WR-SW-ENV never matches WR-SW-ENVX");
});

function runnerWith(mutateConfig) {
  const dir = mkdtempSync(join(tmpdir(), "zev-wa-runner-"));
  try {
    for (const rel of ["scripts/ci/mutants_whatsapp_retirement.mjs", "scripts/ci/mutant_classifier.py", "tests/helpers/text.mjs", "tests/fixtures/forged-webhook-generator.txt"]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(ROOT, rel), join(dir, rel));
    }
    const cfg = JSON.parse(readTextNormalized(CONFIG));
    mutateConfig(cfg.mutants);
    writeFileSync(join(dir, "scripts/ci/mutants_whatsapp_retirement.expected.json"), JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [join(dir, "scripts/ci/mutants_whatsapp_retirement.mjs")], { encoding: "utf8", env, timeout: 120000, windowsHide: true });
    return { status: r.status, out: String(r.stdout) + String(r.stderr) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("runner refuses to start (exit 4) on an unjustified secondary, before any suite or mutant runs", () => {
  requireTool(PYTHON);
  const r = runnerWith((m) => { m.M05_compat_reads_broker_status.secondary[0].justification = ""; });
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /^MUTANT CONFIG REFUSED .*M05_compat_reads_broker_status: secondary entry without justification/m);
  assert.doesNotMatch(r.out, /BASELINE|^MUTANT M\d+/m);
});

test("runner refuses to start (exit 4) on a primary without assertion_pattern or an over-broad entry", () => {
  requireTool(PYTHON);
  const a = runnerWith((m) => { m.M07_edge_classification_removed.primary[0].assertion_pattern = null; });
  assert.equal(a.status, 4, a.out);
  assert.match(a.out, /^MUTANT CONFIG REFUSED primary without assertion_pattern: M07_edge_classification_removed$/m);
  const b = runnerWith((m) => { delete m.M02_constant_flipped.broad_reason; });
  assert.equal(b.status, 4, b.out);
  assert.match(b.out, /^MUTANT CONFIG REFUSED .*M02_constant_flipped: \d+ expected tests \(> 4\) without an explicit broad_reason/m);
});

test("real config: 49 mutants, every primary labelled, every literal label present in the suites", () => {
  const cfg = JSON.parse(readTextNormalized(CONFIG)).mutants;
  assert.equal(Object.keys(cfg).length, 49);
  const suites = ["tests/whatsapp-retirement.test.mjs", "tests/meta-social-manual-only.test.mjs", "tests/whatsapp-config-absence.test.mjs"].map((f) => readTextNormalized(join(ROOT, f))).join("\n");
  for (const [id, spec] of Object.entries(cfg)) {
    assert.ok(spec.primary.length >= 1 && spec.primary.length <= 3, id);
    for (const e of spec.primary) {
      assert.ok(typeof e.assertion_pattern === "string" && e.assertion_pattern.trim(), id + " primary without label");
      const literal = e.assertion_pattern.startsWith("re:") ? (e.assertion_pattern.match(/WR-[A-Z0-9-]+/) || [])[0] : e.assertion_pattern;
      assert.ok(literal && suites.includes("[" + literal + "]"), `${id}: label ${literal} not found in the suites`);
    }
    for (const e of spec.secondary || []) assert.ok(String(e.justification || "").trim().length >= 20, id + " secondary justification");
  }
});
