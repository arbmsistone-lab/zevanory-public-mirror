// Probe suite for tests/test_mutant_classifier_live.py (NOT part of the Node suite manifest: no .test.mjs suffix).
// Six tests (T1, T10, T2, T2a, T2b, T3). PROBE_MODE (comma list) injects a controlled outcome:
//   kill        T1 fails by assertion labelled A1          collide   T10 fails by assertion labelled A1
//   kill_nested T2a fails by assertion labelled A2a        extra     T3 fails by assertion labelled A3
//   label_ok    the label A1 is printed in T10's name     error     T3 throws a plain Error (allowlist case)
//   type        T1 throws a TypeError                      skip/todo T3 is skipped / todo
//   slow        T3 exceeds its 100 ms test timeout         hang      T3 never settles (process-level timeout)
//   source      T1 fails assert.doesNotMatch(SOURCE, ...) labelled A1: node dumps SOURCE into `actual: |-`
//   source_eq   T1 fails assert.equal(SOURCE + x, SOURCE) labelled A1: SOURCE in `actual: |-` AND `expected: |-`
//   deep        T1 fails assert.deepStrictEqual labelled A1 on objects with signal/code/exitCode/... keys
//               (nested `actual:`/`expected:` mappings). SOURCE holds lines that look like YAML diagnostic fields
//               (`signal:`, `code:`, `failureType:`, `error:`, `exitCode:`, `name:`, `type:`); the classifier must
//               not read them as the failure's fields (#898 M09/M16/M20 regression).
import test from "node:test";
import assert from "node:assert/strict";

const mode = new Set(String(process.env.PROBE_MODE || "").split(",").filter(Boolean));
const SOURCE = [
  "export async function forward(url) {",
  "  const res = await fetch(url, {",
  "    signal: AbortSignal.timeout(10000),",
  "  });",
  "  if (!res.ok) throw Object.assign(new Error('upstream'), {",
  "code: 'ERR_MODULE_NOT_FOUND',",
  "failureType: 'testTimeoutFailure',",
  "error: 'upstream timeout',",
  "exitCode: 1,",
  "signal: 'SIGTERM',",
  "name: 'TypeError',",
  "type: 'suite',",
  "  });",
  "}",
].join("\n");

test("T1 alpha", () => {
  if (mode.has("type")) null.boom();
  if (mode.has("source")) assert.doesNotMatch(SOURCE, /AbortSignal\.timeout/, "A1 no hard-coded fetch timeout");
  if (mode.has("source_eq")) assert.equal(`${SOURCE}\nsignal: 'SIGKILL'`, SOURCE, "A1 source unchanged");
  if (mode.has("deep")) {
    assert.deepStrictEqual({ signal: "SIGTERM", code: "ERR_MODULE_NOT_FOUND", exitCode: 3,
      nested: { failureType: "hookFailed", list: ["error: x", { name: "TypeError" }] } },
    { signal: null, code: "ERR_MODULE_NOT_FOUND" }, "A1 deep options");
  }
  assert.equal(mode.has("kill") ? 2 : 1, 1, "A1 alpha value");
});
test(mode.has("label_ok") ? "T10 beta [A1]" : "T10 beta", () => {
  assert.equal(mode.has("collide") ? 2 : 1, 1, "A1 alpha value");
});
test("T2 gamma", async (t) => {
  await t.test("T2a nested", () => assert.equal(mode.has("kill_nested") ? 2 : 1, 1, "A2a nested value"));
  await t.test("T2b nested", () => assert.ok(true));
});
test("T3 delta", { skip: mode.has("skip"), todo: mode.has("todo"), timeout: mode.has("slow") ? 100 : undefined }, async () => {
  if (mode.has("error")) throw new Error("Command failed: psql duplicate key value violates unique constraint");
  if (mode.has("slow")) await new Promise((r) => setTimeout(r, 2000));
  if (mode.has("hang")) await new Promise(() => setInterval(() => {}, 1000));
  assert.equal(mode.has("extra") ? 2 : 1, 1, "A3 unrelated value");
});
