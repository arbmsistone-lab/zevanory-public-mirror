// Meta-tests for scripts/ci/mutant_expectations.mjs (Sol audit 128; semantics of PR #901 mutant_classifier.py), the
// verdict + config validation used by scripts/ci/mutants_whatsapp_retirement.mjs. Synthetic TAP in the real node:test
// shape. Must show INCONCLUSIVE for a failure only in a secondary assertion and for an unrelated failure, and that an
// unjustified or over-broad entry makes the runner refuse to start; plus the B05 cases (truncated TAP, count mismatch,
// crash, skip, signal, colliding prefixes T1/T10).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { classifyTap, loadMutantConfig, validateExpected, testMatches, labelIn, ConfigError } from "../scripts/ci/mutant_expectations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ok = (i, name) => `# Subtest: ${name}\nok ${i} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n`;
const fail = (i, name, msg = "boom") => `# Subtest: ${name}\nnot ok ${i} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  failureType: 'testCodeFailure'\n  error: |-\n    ${msg}\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  ...\n`;
const err = (i, name) => `# Subtest: ${name}\nnot ok ${i} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  failureType: 'testCodeFailure'\n  error: 'x is not a function'\n  code: 'ERR_TEST_FAILURE'\n  name: 'TypeError'\n  ...\n`;
const NAMES = ["T1 alpha rule", "T2 beta rule", "T3 gamma rule", "T10 delta rule"];
function tap(failures = {}, { total = 4, skipped = 0, summary = true, extra = "" } = {}) {
  let body = "TAP version 13\n", nfail = 0;
  NAMES.slice(0, total).forEach((n, i) => { const f = failures[n]; if (f) nfail++; body += f === "error" ? err(i + 1, n) : f ? fail(i + 1, n, f) : ok(i + 1, n); });
  body += extra + `1..${total}\n`;
  if (summary) body += `# tests ${total}\n# suites 0\n# pass ${total - nfail}\n# fail ${nfail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n# duration_ms 5\n`;
  return body;
}
const SPEC = { primary: [{ test_pattern: "T1", assertion_pattern: null }], secondary: [{ test_pattern: "T2", assertion_pattern: null, justification: "T2 reads the same switch the mutant flips, so its assertion fails too" }] };
const v = (failures, opts = {}, spec = SPEC, rc = Object.keys(failures).length ? 1 : 0) => classifyTap({ rc, out: tap(failures, opts), baselineTotal: 4, spec }).verdict;

test("verdict: primary assertion failure is KILLED; primary + justified secondary is KILLED; clean run is SURVIVED", () => {
  assert.equal(v({ "T1 alpha rule": "boom" }), "KILLED");
  assert.equal(v({ "T1 alpha rule": "boom", "T2 beta rule": "boom" }), "KILLED");
  assert.equal(v({}), "SURVIVED");
});

test("verdict: a failure ONLY in a secondary assertion is INCONCLUSIVE", () => {
  assert.equal(v({ "T2 beta rule": "boom" }), "INCONCLUSIVE");
  assert.equal(classifyTap({ rc: 1, out: tap({ "T2 beta rule": "boom" }), baselineTotal: 4, spec: SPEC }).reason, "secondary_only");
});

test("verdict: an unrelated failure is INCONCLUSIVE even next to a primary one", () => {
  assert.equal(v({ "T1 alpha rule": "boom", "T3 gamma rule": "boom" }), "INCONCLUSIVE");
  assert.equal(v({ "T3 gamma rule": "boom" }), "INCONCLUSIVE");
  assert.equal(v({ "T1 alpha rule": "boom", "T2 beta rule": "error" }), "INCONCLUSIVE", "non-assertion failure");
});

test("config: an unjustified or over-broad entry makes the runner refuse to start (loadMutantConfig throws)", () => {
  assert.doesNotThrow(() => loadMutantConfig({ M1: SPEC }, ["M1"]));
  const bad = [
    [{ ...SPEC, secondary: [{ test_pattern: "T2", assertion_pattern: null }] }, /without justification/],
    [{ ...SPEC, secondary: [{ test_pattern: "T2", assertion_pattern: null, justification: "  " }] }, /without justification/],
    [{ primary: [] }, /primary needs 1-3/],
    [{ primary: [1, 2, 3, 4].map((i) => ({ test_pattern: "T" + i })) }, /primary needs 1-3/],
    [{ primary: [{ test_pattern: "A" }], secondary: ["B", "C", "D", "E"].map((t) => ({ test_pattern: t, justification: "causal reason for " + t })) }, /without an explicit broad_reason/],
    [{ ...SPEC, extra: 1 }, /unknown expected keys/],
  ];
  for (const [spec, re] of bad) assert.throws(() => loadMutantConfig({ M1: spec }), (e) => e instanceof ConfigError && re.test(e.message));
  assert.doesNotThrow(() => validateExpected({ primary: [{ test_pattern: "A" }], secondary: ["B", "C", "D", "E"].map((t) => ({ test_pattern: t, justification: "causal reason for " + t })), broad_reason: "the master switch gates every path" }));
  assert.throws(() => loadMutantConfig({ M1: SPEC }, ["M1", "M2"]), /config\/mutant mismatch/);
});

test("runner: mutants_whatsapp_retirement.mjs refuses to start (exit 4) on an unjustified secondary, before any mutant", () => {
  const dir = mkdtempSync(join(tmpdir(), "zev-mut-cfg-"));
  try {
    for (const rel of ["scripts/ci/mutants_whatsapp_retirement.mjs", "scripts/ci/mutant_expectations.mjs", "tests/helpers/text.mjs", "tests/fixtures/forged-webhook-generator.txt"]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(ROOT, rel), join(dir, rel));
    }
    const cfg = JSON.parse(readTextNormalized(join(ROOT, "scripts/ci/mutants_whatsapp_retirement.expected.json")));
    cfg.mutants.M05_compat_reads_broker_status.secondary[0].justification = "";
    writeFileSync(join(dir, "scripts/ci/mutants_whatsapp_retirement.expected.json"), JSON.stringify(cfg));
    let out = "", status = 0;
    try { out = execFileSync(process.execPath, [join(dir, "scripts/ci/mutants_whatsapp_retirement.mjs")], { encoding: "utf8", timeout: 60000 }); }
    catch (e) { out = String(e.stdout || ""); status = e.status; }
    assert.equal(status, 4, out);
    assert.match(out, /^MUTANT CONFIG REFUSED .*M05_compat_reads_broker_status: secondary entry without justification/m);
    assert.doesNotMatch(out, /BASELINE|^MUTANT M\d+/m, "no suite or mutant may run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real config: all 49 mutants valid, 1-3 primaries each, every secondary justified", () => {
  const cfg = JSON.parse(readTextNormalized(join(ROOT, "scripts/ci/mutants_whatsapp_retirement.expected.json")));
  const norm = loadMutantConfig(cfg.mutants);
  assert.equal(Object.keys(norm).length, 49);
  for (const [id, s] of Object.entries(norm)) {
    assert.ok(s.primary.length >= 1 && s.primary.length <= 3, id);
    for (const e of s.secondary) assert.ok(e.justification.trim().length >= 20, id + " justification too short");
  }
});

test("B05 cases: truncated TAP, count mismatch, crash outside blocks, skip, signal, rc other than 0/1 are INCONCLUSIVE", () => {
  const f = { "T1 alpha rule": "boom" };
  assert.equal(v(f, { summary: false }), "INCONCLUSIVE", "truncated");
  assert.equal(classifyTap({ rc: 1, out: tap(f, { total: 3 }), baselineTotal: 4, spec: SPEC }).verdict, "INCONCLUSIVE", "count mismatch");
  assert.equal(v(f, { extra: "SyntaxError: Unexpected token\n" }), "INCONCLUSIVE", "crash");
  assert.equal(v(f, { skipped: 1 }), "INCONCLUSIVE", "skip");
  assert.equal(classifyTap({ rc: null, signal: "SIGKILL", out: tap(f), baselineTotal: 4, spec: SPEC }).verdict, "INCONCLUSIVE", "signal");
  assert.equal(classifyTap({ rc: 7, out: tap(f), baselineTotal: 4, spec: SPEC }).verdict, "INCONCLUSIVE", "rc 7");
  assert.equal(classifyTap({ rc: 1, out: tap(f).replace(/\n/g, "\r\n"), baselineTotal: 4, spec: SPEC }).verdict, "KILLED", "CRLF TAP");
});

test("matching: token-boundary prefixes (T1 never matches T10) and word-boundary labels", () => {
  assert.equal(testMatches("T1", "T1 alpha rule"), true);
  assert.equal(testMatches("T1", "T10 delta rule"), false);
  assert.equal(testMatches("status surfaces:", "status surfaces: x"), true);
  assert.equal(v({ "T10 delta rule": "boom" }), "INCONCLUSIVE", "T10 failure does not kill a T1 primary");
  assert.equal(labelIn("A1", "assertion A10 failed"), false);
  assert.equal(labelIn("A1", "assertion A1 failed"), true);
  const labelled = { primary: [{ test_pattern: "T1", assertion_pattern: "must stay closed" }] };
  assert.equal(v({ "T1 alpha rule": "channel must stay closed" }, {}, labelled), "KILLED");
  assert.equal(v({ "T1 alpha rule": "other assertion" }, {}, labelled), "INCONCLUSIVE", "primary test, wrong assertion");
});
