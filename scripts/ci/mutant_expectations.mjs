// ZEVANORY | Mutant expectations + TAP verdict for .mjs mutant runners (Sol audit 128, binding).
// Local port of the semantics of scripts/ci/mutant_classifier.py from PR #901 (load_mutant_config / classify),
// kept compatible so a runner can switch to the shared Python module once #901 is authorised:
//   spec per mutant = { primary: [1-3 {test_pattern, assertion_pattern}],
//                       secondary: [{test_pattern, assertion_pattern, justification}],
//                       broad_reason?: string (mandatory when primary+secondary name > 4 distinct tests) }
//   test_pattern       literal prefix with a token boundary ("T1" matches "T1 alpha", never "T10 beta"); "re:" = regex
//   assertion_pattern  label with word boundaries searched in the failing block; null = any assertion failure; "re:"
// Expected assertions are derived by reasoning about the mutation (which rule it breaks, which assertions encode it),
// never by recording which tests happened to fail.
// Verdicts:
//   KILLED       complete TAP (plan + tests/pass/fail/cancelled/skipped/todo), tests == baseline, rc 1, no
//                skip/todo/cancelled, no crash signature outside the failure blocks, at least one ASSERTION failure in a
//                PRIMARY expected test, and every other failure is a primary or a justified secondary assertion.
//   SURVIVED     rc 0, complete TAP, tests == pass == baseline, fail == 0.
//   INCONCLUSIVE everything else (timeout, signal, crash, truncated TAP, count mismatch, non-assertion failure,
//                unexpected failure, failure only in secondary assertions). Never promoted to KILLED.

export class ConfigError extends Error {}
export const MAX_PRIMARY = 3;
export const MAX_TESTS_WITHOUT_BROAD_REASON = 4;
const SPEC_KEYS = new Set(["primary", "secondary", "broad_reason"]);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

export function validateExpected(spec, id = "?") {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new ConfigError(`${id}: expected must be an object with primary/secondary`);
  const unknown = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k));
  if (unknown.length) throw new ConfigError(`${id}: unknown expected keys ${unknown.join(",")}`);
  const prim = spec.primary, sec = spec.secondary ?? [];
  if (!Array.isArray(prim) || prim.length < 1 || prim.length > MAX_PRIMARY) throw new ConfigError(`${id}: primary needs 1-${MAX_PRIMARY} assertions that directly test the mutated rule`);
  if (!Array.isArray(sec)) throw new ConfigError(`${id}: secondary must be a list`);
  for (const [role, entries] of [["primary", prim], ["secondary", sec]]) {
    for (const e of entries) {
      if (!e || typeof e !== "object" || !nonEmpty(e.test_pattern)) throw new ConfigError(`${id}: ${role} entry needs a non-empty test_pattern`);
      if (e.assertion_pattern != null && typeof e.assertion_pattern !== "string") throw new ConfigError(`${id}: ${role} assertion_pattern must be a string or null`);
      if (role === "secondary" && !nonEmpty(e.justification)) throw new ConfigError(`${id}: secondary entry without justification: ${e.test_pattern}`);
    }
  }
  const tests = new Set([...prim, ...sec].map((e) => e.test_pattern));
  if (spec.broad_reason != null && !nonEmpty(spec.broad_reason)) throw new ConfigError(`${id}: broad_reason must be a non-empty string`);
  if (tests.size > MAX_TESTS_WITHOUT_BROAD_REASON && !nonEmpty(spec.broad_reason)) throw new ConfigError(`${id}: ${tests.size} expected tests (> ${MAX_TESTS_WITHOUT_BROAD_REASON}) without an explicit broad_reason`);
  return { primary: prim.map((e) => ({ ...e, role: "primary" })), secondary: sec.map((e) => ({ ...e, role: "secondary" })), broad_reason: spec.broad_reason ?? null };
}

// Whole-runner config; runners MUST call this before running any mutant (it throws ConfigError on any defect).
export function loadMutantConfig(config, ids = null) {
  if (!config || typeof config !== "object" || !Object.keys(config).length) throw new ConfigError("mutant config must be a non-empty {mutant_id: spec} mapping");
  const out = {};
  for (const [id, spec] of Object.entries(config)) out[id] = validateExpected(spec, id);
  if (ids) {
    const missing = ids.filter((id) => !(id in out)), extra = Object.keys(out).filter((id) => !ids.includes(id));
    if (missing.length || extra.length) throw new ConfigError(`config/mutant mismatch missing=${missing.join(",")} extra=${extra.join(",")}`);
  }
  return out;
}

export function testMatches(pattern, name) {
  if (!pattern) return false;
  if (pattern.startsWith("re:")) return new RegExp("^(?:" + pattern.slice(3) + ")").test(name);
  if (!name.startsWith(pattern)) return false;
  if (name.length === pattern.length || !/\w/.test(pattern.at(-1))) return true;
  return !/\w/.test(name[pattern.length]);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function labelIn(pattern, text) {
  if (!pattern) return true;
  if (!text) return false;
  if (pattern.startsWith("re:")) return new RegExp(pattern.slice(3)).test(text);
  return new RegExp("(?<!\\w)" + escapeRe(pattern) + "(?!\\w)").test(text);
}

const COUNT_KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const ASSERT_RE = /^\s+code: '?ERR_ASSERTION'?$|^\s+name: '?AssertionError'?$/m;
const INFRA_RE = [
  /^\s*(?:#\s*)?(?:Uncaught )?(?:SyntaxError|TypeError|ReferenceError)\b/m,
  /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package) ['"]/,
  /FATAL ERROR:|Segmentation fault|Aborted \(core dumped\)/i,
  /^\s*(?:#\s*)?Node\.js v\d+\.\d+\.\d+\s*$/m,
];
const FAIL_BLOCK = /^not ok \d+ - ([^\n]*)\n((?:[ \t]+[^\n]*\n|\n)*?)  \.\.\.$/gm;

export function parseTap(raw) {
  const out = String(raw ?? "").replace(/\r\n?/g, "\n");
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, Number((out.match(new RegExp(`^# ${k} (\\d+)$`, "m")) || [])[1] ?? -1)]));
  const plan = /^1\.\.\d+$/m.test(out);
  const blocks = [...out.matchAll(FAIL_BLOCK)].map((m) => ({ name: m[1].trim(), body: m[2], assertion: ASSERT_RE.test(m[2]) }));
  const outside = out.replace(FAIL_BLOCK, "");
  const infra = INFRA_RE.filter((re) => re.test(outside)).map((re) => re.source.slice(0, 40));
  const nested = (out.match(/^[ \t]+not ok \d+ - /gm) || []).length;
  return { counts, plan, blocks, infra, nested, out };
}

// -> { verdict, reason, killing_tests, unexpected }
export function classifyTap({ rc, signal = null, out, baselineTotal, spec }) {
  const norm = validateExpected(spec);
  const res = (verdict, reason, extra = {}) => ({ verdict, reason, killing_tests: [], unexpected: [], ...extra });
  if (signal || rc === null || rc === undefined || rc < 0) return res("INCONCLUSIVE", `signal_or_timeout rc=${rc} signal=${signal}`);
  const t = parseTap(out);
  const c = t.counts;
  if (!t.plan || COUNT_KEYS.some((k) => c[k] < 0)) return res("INCONCLUSIVE", "tap_incomplete");
  if (c.tests !== baselineTotal || c.pass + c.fail !== c.tests) return res("INCONCLUSIVE", `count_mismatch tests=${c.tests} pass=${c.pass} fail=${c.fail} baseline=${baselineTotal}`);
  if (c.cancelled || c.skipped || c.todo) return res("INCONCLUSIVE", `skip_todo_cancelled ${c.skipped}/${c.todo}/${c.cancelled}`);
  if (t.infra.length) return res("INCONCLUSIVE", "infra_outside_blocks:" + t.infra.join("|"));
  if (rc === 0) return c.fail === 0 && !t.blocks.length && c.pass === baselineTotal ? res("SURVIVED", "clean") : res("INCONCLUSIVE", "rc0_with_failures");
  if (rc !== 1) return res("INCONCLUSIVE", `rc_${rc}`);
  if (!t.blocks.length || t.blocks.length !== c.fail || t.nested) return res("INCONCLUSIVE", `failure_blocks_inconsistent blocks=${t.blocks.length} fail=${c.fail} nested=${t.nested}`);
  const matches = (entries, b) => entries.some((e) => testMatches(e.test_pattern, b.name) && labelIn(e.assertion_pattern, b.body));
  const killing = [], unexpected = [];
  for (const b of t.blocks) {
    if (!b.assertion) unexpected.push(b.name.slice(0, 48) + ":non_assertion");
    else if (matches(norm.primary, b)) killing.push(b.name.slice(0, 48));
    else if (!matches(norm.secondary, b)) unexpected.push(b.name.slice(0, 48) + ":unexpected");
  }
  if (unexpected.length) return res("INCONCLUSIVE", "unexpected_failure:" + unexpected.join(";"), { unexpected });
  if (!killing.length) return res("INCONCLUSIVE", "secondary_only");
  return res("KILLED", "primary_assertion", { killing_tests: killing });
}
