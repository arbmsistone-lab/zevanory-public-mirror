#!/usr/bin/env python3
"""Shared mutation-test classifier: one verdict function for every mutant runner (spec: auditor Sol).

Every runner in scripts/ci/mutants_*.{py,mjs} grew its own KILLED/SURVIVED logic; the strictest one is
scripts/ci/mutants_mp_webhook.py (B05: assertion inside the expected `not ok` block, exact counts, causal allowlist,
self-checks). This module is that logic, generalised and fail-closed, so runners can converge on it. It has no
third-party dependencies, needs no network or secrets, and behaves the same on Linux and Windows (LF and CRLF).

Verdicts (``classify``)
  KILLED       complete TAP; ``# tests`` equals the baseline; rc consistent with the summary; no skip/todo/cancelled;
               no infrastructure signal; at least one ASSERTION failure inside the `not ok` block of a PRIMARY expected
               test, carrying its assertion label; every other failure is primary, a justified SECONDARY, or in the
               narrow causal allowlist (test + regex over the block + written reason; never for infra kinds).
               Failures only in secondary assertions are INCONCLUSIVE (audit 128).
  SURVIVED     rc 0; complete TAP; tests == pass == baseline; fail == skipped == todo == cancelled == 0.
  INCONCLUSIVE everything else: timeout, signal, crash, SyntaxError/TypeError/ReferenceError, missing module or tool,
               process-level failure, non-unique anchor, truncated TAP, count mismatch or inconsistent summary,
               unexpected failure, expected label found only outside the expected block, rc inconsistent with summary.
  INCONCLUSIVE is never promoted to KILLED. Retrying is the runner's decision; a persistent INCONCLUSIVE fails the job.

Expected assertions (audit 128, binding)
  Per mutant: {"primary": [1-3 entries], "secondary": [entries, each with a non-empty "justification"],
  "broad_reason": "..." (mandatory when primary+secondary name more than 4 distinct tests)}; an entry is
  {"test_pattern", "assertion_pattern"}. PRIMARY entries are the assertions that directly test the mutated rule;
  SECONDARY entries are collateral failures the mutation causally implies, each explained.
  Expected assertions MUST be derived by reasoning about the mutation (which rule it breaks and which assertions encode
  that rule) BEFORE running it, never by recording the failures observed when the mutant runs: copying observed
  failures turns any regression, flake or harness defect into a "kill".
  ``load_mutant_config`` validates every mutant's expectations and allowlist and raises ``ConfigError`` (missing
  justification, missing broad_reason, 0 or >3 primaries, unknown keys, allowlist without reason or covering infra);
  runners MUST call it before running any mutant. ``classify`` re-validates and raises on a malformed spec.

Matching rules
  test_pattern       literal prefix of a test name with a token boundary ("T1" matches "T1 alpha" and "T1", never
                     "T10 beta"); it is checked against the failing test AND its ancestors (a nested failure belongs to
                     the parent block). Prefix "re:" switches to a regular expression anchored at the start.
  assertion_pattern  label searched with word boundaries ("A1" never matches "A10") in the failure's ``assertion_id``
                     when the runner supplies one, otherwise in the block's ``error:`` text. Empty/None: any assertion
                     failure of that test. Prefix "re:" switches to a regular expression (search).

Exit codes (``aggregate``; also the CLI): 0 all KILLED; 1 any SURVIVED; 2 invalid baseline; 3 any INCONCLUSIVE.
  Precedence when several apply: 2 > 3 > 1 > 0 (an untrustworthy run outranks a survivor; both are listed in JSON).

How a runner adopts it
  0. Config: declare every mutant's expectations and allowlist in one mapping and call ``load_mutant_config``
     before anything runs (it raises ConfigError on any defect).
  1. Baseline: run the suite unmutated with ``run_command`` and require ``validate_baseline(...)["ok"]``; otherwise
     exit 2 without running mutants. Pin the baseline total (``# tests``) as a literal or a manifest entry.
  2. Per mutant: apply the edit; if the anchor is missing or not unique pass ``anchor_ok=False`` (do not skip). Run
     ``run_command([... "node", "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...])``,
     restore the source (verify its hash), then
         spec = config["M1_x"]   # {"primary": [...], "secondary": [...], "broad_reason": ..., "allowlist": [...]}
         res = classify_run(baseline_total, run, expected=spec, allowlist=spec["allowlist"], anchor_ok=True,
                            mutant_id="M1_x")
     and print ``json.dumps(res)`` (one line per mutant; JSON Lines).
  3. Finish with ``code, summary = aggregate(results, baseline_valid=True)`` and ``sys.exit(code)``.
  Non-Python runners (.mjs) can write the TAP to a file and call the CLI:
      python scripts/ci/mutant_classifier.py classify --baseline-total 25 --rc 1 --tap out.tap \
          --expected '{"primary":[{"test_pattern":"kill-switch:","assertion_pattern":null}]}' --mutant-id M01 >> results.jsonl
      python scripts/ci/mutant_classifier.py aggregate results.jsonl
  Gates that emit structured decisions instead of TAP (the #875 audiovisual gate) use ``classify_structured_events``.
  ``python scripts/ci/mutant_classifier.py self-check`` exercises the classifier on embedded fixtures.
  Meta-tests: tests/test_mutant_classifier.py (fixtures) and tests/test_mutant_classifier_live.py (real Node 22/24).
"""
from __future__ import annotations

import argparse
import json
import re
import signal as _signal
import subprocess
import sys

KILLED, SURVIVED, INCONCLUSIVE = "KILLED", "SURVIVED", "INCONCLUSIVE"
VERDICTS = (KILLED, SURVIVED, INCONCLUSIVE)
EXIT_ALL_KILLED, EXIT_SURVIVED, EXIT_BAD_BASELINE, EXIT_INCONCLUSIVE = 0, 1, 2, 3
COUNT_KEYS = ("tests", "pass", "fail", "cancelled", "skipped", "todo")

# Failure kinds. Only ASSERTION can kill; ASSERTION and ERROR may be allowlisted; everything in INFRA_KINDS is
# INCONCLUSIVE outright. SUBTESTS is the structural parent of a nested failure (it must have a failing descendant).
ASSERTION, ERROR, SUBTESTS = "assertion", "error", "subtests"
INFRA_KINDS = frozenset({"syntax_error", "type_error", "reference_error", "missing_module", "missing_tool",
                         "timeout", "cancelled", "hook", "process_exit", "signal"})
ALLOWLISTABLE_KINDS = frozenset({ASSERTION, ERROR})

# Infrastructure signatures in lines OUTSIDE the YAML blocks (file-level crash dumps printed as `# ...` diagnostics,
# merged stderr) and in stderr. Anchored to line starts so an assertion message quoting them cannot trigger them.
INFRA_LINE_RE = [
    ("syntax_error", re.compile(r"^\s*(?:#\s*)?(?:Uncaught )?SyntaxError\b")),
    ("type_error", re.compile(r"^\s*(?:#\s*)?(?:Uncaught )?TypeError\b")),
    ("reference_error", re.compile(r"^\s*(?:#\s*)?(?:Uncaught )?ReferenceError\b")),
    ("missing_module", re.compile(r"ERR_MODULE_NOT_FOUND|Cannot find (?:module|package) ['\"]|MODULE_NOT_FOUND")),
    ("missing_tool", re.compile(r"command not found|is not recognized as an internal or external command|"
                                r"spawn \S+ ENOENT|No such file or directory: '(?:node|npx|npm)'")),
    ("crash", re.compile(r"^\s*(?:#\s*)?Node\.js v\d+\.\d+\.\d+\s*$")),
    ("crash", re.compile(r"FATAL ERROR:|Segmentation fault|Aborted \(core dumped\)|out of memory", re.I)),
]

_POINT = re.compile(r"^(?P<ind>[ ]*)(?P<st>not ok|ok)[ ]+(?P<num>\d+)(?:[ ]+-[ ]+(?P<name>.*?))?"
                    r"(?:[ ]+(?<!\\)#[ ]+(?P<dir>SKIP|TODO)\b.*)?[ ]*$", re.I)
_PLAN = re.compile(r"^(?P<ind>[ ]*)1\.\.(?P<n>\d+)\b")
_SUMMARY = re.compile(r"^(?:#|ℹ)[ ]?(?P<k>tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)[ ]+"
                      r"(?P<v>\d+(?:\.\d+)?)[ ]*$")
_SUBTEST = re.compile(r"^[ ]*#[ ]Subtest:[ ]")


def _normalize(text):
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    return (text or "").replace("\r\n", "\n").replace("\r", "\n")


def _unescape(name):
    return re.sub(r"\\(.)", r"\1", name or "")


def _yaml_field(block_lines, field):
    """Value of a scalar field in a node --test YAML diagnostic block (quoted, plain or |- literal)."""
    for i, ln in enumerate(block_lines):
        m = re.match(r"^(?P<ind>[ ]*)" + re.escape(field) + r":[ ]?(?P<v>.*)$", ln)
        if not m:
            continue
        v = m.group("v").strip()
        if v in ("|-", "|", ">-", ">"):
            ind, out = len(m.group("ind")), []
            for nxt in block_lines[i + 1:]:
                if nxt.strip() and len(nxt) - len(nxt.lstrip(" ")) <= ind:
                    break
                out.append(nxt.strip())
            return "\n".join(out).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        return v
    return None


def _failure_kind(f):
    ftype, name, code = f.get("failureType") or "", f.get("name") or "", f.get("code") or ""
    err = f.get("error") or ""
    sig, exit_code = f.get("signal"), f.get("exitCode")
    if ftype == "testTimeoutFailure":
        return "timeout"
    if ftype == "cancelledByParent":
        return "cancelled"
    if ftype == "hookFailed":
        return "hook"
    if ftype == "subtestsFailed":
        return SUBTESTS
    if sig not in (None, "", "~", "null"):
        return "signal"
    if exit_code not in (None, "", "~", "null"):
        return "process_exit"
    if code in ("ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND") or re.search(r"Cannot find (?:module|package) ", err):
        return "missing_module"
    if re.search(r"spawn \S+ ENOENT|command not found", err):
        return "missing_tool"
    if name == "SyntaxError":
        return "syntax_error"
    if name == "TypeError":
        return "type_error"
    if name == "ReferenceError":
        return "reference_error"
    if code == "ERR_ASSERTION" or name == "AssertionError":
        return ASSERTION
    return ERROR


def parse_tap(text, extra_infra=(), stderr=""):
    """Split `node --test` TAP output into per-test blocks (LF or CRLF; Node 22 and 24).

    Returns {"summary": {...counts, "complete", "problems", "infra", "points"}, "failures": [...]}; each failure is
    {test_id, name, path, kind, block, error, assertion_id: None, depth, directive}. ``summary`` is the
    ``tap_summary`` argument of ``classify``. Counts that are absent are -1.
    """
    lines = _normalize(text).split("\n")
    infra_res = list(INFRA_LINE_RE) + [("extra_infra", re.compile(p)) if isinstance(p, str) else ("extra_infra", p)
                                       for p in extra_infra]
    problems, infra, points, summary_seen = [], [], [], {}
    counts = {k: -1 for k in COUNT_KEYS}
    top_plan, header = None, False
    i, n = 0, len(lines)
    while i < n:
        ln = lines[i]
        if ln.startswith("TAP version"):
            header = True
            i += 1
            continue
        m = _POINT.match(ln)
        if m:
            ind = len(m.group("ind"))
            pt = {"indent": ind, "ok": m.group("st").lower() == "ok", "name": _unescape(m.group("name")).strip(),
                  "directive": (m.group("dir") or "").upper() or None, "line": ln, "yaml": [], "parent": None}
            j = i + 1
            if j < n and lines[j] == " " * (ind + 2) + "---":
                k = j + 1
                while k < n and lines[k] != " " * (ind + 2) + "...":
                    k += 1
                if k >= n:
                    problems.append(f"unclosed_yaml_block:{pt['name'][:60]}")
                    pt["yaml"] = lines[j + 1:]
                    i = n
                else:
                    pt["yaml"] = lines[j + 1:k]
                    i = k + 1
            else:
                i = j
            # children were printed before the parent: adopt the trailing deeper points without a parent yet
            for prev in reversed(points):
                if prev["indent"] <= ind:
                    break
                if prev["parent"] is None and prev["indent"] > ind:
                    prev["parent"] = pt
            points.append(pt)
            continue
        pm = _PLAN.match(ln)
        if pm and len(pm.group("ind")) == 0:
            if top_plan is not None:
                problems.append("duplicate_top_level_plan")
            top_plan = int(pm.group("n"))
            i += 1
            continue
        sm = _SUMMARY.match(ln)
        if sm:
            k, v = sm.group("k"), sm.group("v")
            if k in summary_seen:
                problems.append(f"duplicate_summary_{k}")
            summary_seen[k] = v
            if k in counts:
                counts[k] = int(float(v))
            i += 1
            continue
        if not _SUBTEST.match(ln):
            for label, rx in infra_res:
                if rx.search(ln):
                    infra.append(f"{label}:{ln.strip()[:120]}")
                    break
        i += 1
    for ln in _normalize(stderr).split("\n"):
        for label, rx in infra_res:
            if rx.search(ln):
                infra.append(f"stderr_{label}:{ln.strip()[:120]}")
                break

    # paths and per-point fields
    failures, tallies = [], {"tests": 0, "pass": 0, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
    for pt in points:
        path, p = [], pt
        while p is not None:
            path.append(p["name"])
            p = p["parent"]
        pt["path"] = list(reversed(path))
        y = pt["yaml"]
        fields = {f: _yaml_field(y, f) for f in ("type", "failureType", "name", "code", "error", "exitCode", "signal")}
        pt.update(fields_=fields)
        if fields["type"] == "suite":
            pt["is_suite"] = True
        else:
            pt["is_suite"] = False
            tallies["tests"] += 1
            if pt["directive"] == "SKIP":
                tallies["skipped"] += 1
            elif pt["directive"] == "TODO":
                tallies["todo"] += 1
            elif pt["ok"]:
                tallies["pass"] += 1
            elif fields["failureType"] in ("cancelledByParent", "testTimeoutFailure"):
                tallies["cancelled"] += 1
            else:
                tallies["fail"] += 1
        if not pt["ok"] and pt["directive"] != "TODO":
            fl = {"test_id": " > ".join(pt["path"]), "name": pt["name"], "path": pt["path"], "depth": len(pt["path"]) - 1,
                  "block": "\n".join([pt["line"]] + y), "error": fields["error"] or "", "assertion_id": None,
                  "directive": pt["directive"], "is_suite": pt["is_suite"], **{k: fields[k] for k in fields}}
            fl["kind"] = _failure_kind(fl)
            failures.append(fl)

    top = [p for p in points if p["indent"] == 0]
    if not points and not summary_seen:
        problems.append("no_tap_output")
    if top_plan is None:
        problems.append("missing_top_level_plan")
    elif top_plan != len(top):
        problems.append(f"plan_{top_plan}_vs_{len(top)}_top_level_points")
    for k in COUNT_KEYS:
        if counts[k] < 0:
            problems.append(f"missing_summary_{k}")
    if any(p["parent"] is None and p["indent"] > 0 for p in points):
        problems.append("orphan_nested_point")
    consistency = []
    if all(counts[k] >= 0 for k in COUNT_KEYS):
        if counts["tests"] != sum(counts[k] for k in COUNT_KEYS[1:]):
            consistency.append("tests_ne_pass+fail+cancelled+skipped+todo")
        for k in COUNT_KEYS:
            if tallies[k] != counts[k]:
                consistency.append(f"{k}:summary={counts[k]},points={tallies[k]}")
    summary = {**counts, "complete": not problems, "problems": problems, "consistent": not consistency,
               "inconsistencies": consistency, "infra": infra, "header": header,
               "points": [{"test_id": " > ".join(p["path"]), "ok": p["ok"], "directive": p["directive"],
                           "text": "\n".join([p["line"]] + p["yaml"])} for p in points]}
    return {"summary": summary, "failures": failures}


# ---------------------------------------------------------------- matching
def _test_matches(pattern, name):
    if not pattern:
        return False
    if pattern.startswith("re:"):
        return re.match(pattern[3:], name) is not None
    if not name.startswith(pattern):
        return False
    if len(name) == len(pattern) or not re.match(r"\w", pattern[-1]):
        return True
    return not re.match(r"\w", name[len(pattern)])


def _path_matches(pattern, failure):
    path = failure.get("path") or [failure.get("test_id") or failure.get("name") or ""]
    return any(_test_matches(pattern, el) for el in path)


def _label_in(pattern, text):
    if not text:
        return False
    if pattern.startswith("re:"):
        return re.search(pattern[3:], text) is not None
    return re.search(r"(?<!\w)" + re.escape(pattern) + r"(?!\w)", text) is not None


def _label_matches(pattern, failure):
    if not pattern:
        return True
    if failure.get("assertion_id"):
        return _label_in(pattern, str(failure["assertion_id"]))
    return _label_in(pattern, failure.get("error") or failure.get("block") or "")


class ConfigError(ValueError):
    """A mutant's expectations or allowlist are malformed; runners must stop before running any mutant."""


MAX_PRIMARY, MAX_TESTS_WITHOUT_BROAD_REASON = 3, 4
_SPEC_KEYS = {"primary", "secondary", "broad_reason", "allowlist"}


def _nonempty_str(v):
    return isinstance(v, str) and v.strip() != ""


def validate_expected(spec, mutant_id="?"):
    """Validate one mutant's expectations -> normalised {"primary", "secondary", "broad_reason"}; raises ConfigError."""
    if not isinstance(spec, dict):
        raise ConfigError(f"{mutant_id}: expected must be a dict with primary/secondary (got {type(spec).__name__})")
    unknown = set(spec) - _SPEC_KEYS
    if unknown:
        raise ConfigError(f"{mutant_id}: unknown expected keys {sorted(unknown)}")
    prim, sec = spec.get("primary"), spec.get("secondary") or []
    if not isinstance(prim, list) or not 1 <= len(prim) <= MAX_PRIMARY:
        raise ConfigError(f"{mutant_id}: primary needs 1-{MAX_PRIMARY} assertions that directly test the mutated rule")
    if not isinstance(sec, list):
        raise ConfigError(f"{mutant_id}: secondary must be a list")
    for role, entries in (("primary", prim), ("secondary", sec)):
        for e in entries:
            if not isinstance(e, dict) or not _nonempty_str(e.get("test_pattern")):
                raise ConfigError(f"{mutant_id}: {role} entry needs a non-empty test_pattern: {e!r}")
            ap = e.get("assertion_pattern")
            if ap is not None and not isinstance(ap, str):
                raise ConfigError(f"{mutant_id}: {role} assertion_pattern must be a string or null: {e!r}")
            if role == "secondary" and not _nonempty_str(e.get("justification")):
                raise ConfigError(f"{mutant_id}: secondary entry without justification: {e!r}")
    tests = {e["test_pattern"] for e in prim + sec}
    broad = spec.get("broad_reason")
    if broad is not None and not _nonempty_str(broad):
        raise ConfigError(f"{mutant_id}: broad_reason must be a non-empty string")
    if len(tests) > MAX_TESTS_WITHOUT_BROAD_REASON and not _nonempty_str(broad):
        raise ConfigError(f"{mutant_id}: {len(tests)} expected tests (> {MAX_TESTS_WITHOUT_BROAD_REASON}) "
                          f"without an explicit broad_reason")
    return {"primary": [dict(e, role="primary") for e in prim],
            "secondary": [dict(e, role="secondary") for e in sec], "broad_reason": broad}


def validate_allowlist(allowlist, mutant_id="?"):
    if not isinstance(allowlist, list):
        raise ConfigError(f"{mutant_id}: allowlist must be a list")
    for a in allowlist:
        if not (isinstance(a, dict) and _nonempty_str(a.get("id")) and _nonempty_str(a.get("test_pattern"))
                and _nonempty_str(a.get("regex")) and _nonempty_str(a.get("why"))):
            raise ConfigError(f"{mutant_id}: allowlist entry needs id, test_pattern, regex and a written why: {a!r}")
        try:
            re.compile(a["regex"])
        except re.error as e:
            raise ConfigError(f"{mutant_id}: allowlist {a['id']} regex invalid: {e}") from None
        bad = set(a.get("kinds") or ALLOWLISTABLE_KINDS) - ALLOWLISTABLE_KINDS
        if bad:
            raise ConfigError(f"{mutant_id}: allowlist entry {a['id']} cannot cover infra kinds {sorted(bad)}")
    return list(allowlist)


def load_mutant_config(config):
    """Validate {mutant_id: {primary, secondary, broad_reason?, allowlist?}} for a whole runner, before any mutant
    runs. Returns the normalised config; raises ConfigError on the first defect (missing justification, unjustified
    breadth, bad primary count, malformed allowlist)."""
    if not isinstance(config, dict) or not config:
        raise ConfigError("mutant config must be a non-empty {mutant_id: spec} mapping")
    out = {}
    for mid, spec in config.items():
        norm = validate_expected(spec, mid)
        norm["allowlist"] = validate_allowlist(spec.get("allowlist") or [], mid)
        out[mid] = norm
    return out


def _validate_config(expected, allowlist):
    norm = validate_expected(expected) if expected else {"primary": [], "secondary": [], "broad_reason": None}
    validate_allowlist(list(allowlist))
    return norm


def _result(verdict, reason, **kw):
    out = {"verdict": verdict, "reason": reason, "killing_tests": [], "assertion_ids": [], "allowlist_used": [],
           "unexpected_failures": []}
    out.update(kw)
    return out


def classify(baseline_total, return_code, tap_summary, failures=(), expected=(), anchor_ok=True, timed_out=False,
             signal=None, allowlist=(), mutant_id=None):
    """-> dict {verdict: KILLED|SURVIVED|INCONCLUSIVE, reason, killing_tests, assertion_ids, counts, ...}.

    ``tap_summary`` and ``failures`` normally come from ``parse_tap``. A runner may pre-label failures with
    ``assertion_id``. ``expected`` = {primary: [...], secondary: [{..., justification}], broad_reason?} (empty only
    for a baseline); ``allowlist`` = [{id, test_pattern, regex, why, kinds?}]. Never raises on bad run data, only
    (ConfigError) on a malformed spec.
    """
    allowlist, failures = list(allowlist or ()), list(failures or ())
    norm = _validate_config(expected, allowlist)
    primary, secondary = norm["primary"], norm["secondary"]
    expected = primary + secondary
    s = dict(tap_summary or {})
    counts = {k: s.get(k, -1) for k in COUNT_KEYS}
    base = {"mutant_id": mutant_id, "counts": counts, "baseline_total": baseline_total, "return_code": return_code,
            "failures_total": len(failures)}

    def inc(reason, **kw):
        return _result(INCONCLUSIVE, reason, **base, **kw)

    if timed_out:
        return inc("timeout")
    if signal not in (None, "", 0):
        return inc(f"signal:{signal}")
    if return_code is None:
        return inc("crash:no_return_code")
    if isinstance(return_code, int) and return_code < 0:
        return inc(f"signal:rc{return_code}")
    if not anchor_ok:
        return inc("anchor_not_unique")
    if not isinstance(baseline_total, int) or isinstance(baseline_total, bool) or baseline_total < 1:
        return inc(f"invalid_baseline_total:{baseline_total!r}")
    if s.get("infra"):
        return inc("infra:" + ";".join(s["infra"])[:240])
    if not s.get("complete", False):
        return inc("truncated_tap:" + ",".join(s.get("problems") or ["incomplete"])[:240])
    if s.get("consistent") is False:
        return inc("count_inconsistent:" + ",".join(s.get("inconsistencies") or [])[:240])
    if any(not isinstance(counts[k], int) or counts[k] < 0 for k in COUNT_KEYS):
        return inc("truncated_tap:missing_counts")
    if counts["tests"] != counts["pass"] + counts["fail"] + counts["cancelled"] + counts["skipped"] + counts["todo"]:
        return inc("count_inconsistent:tests_ne_sum")
    if counts["tests"] != baseline_total:
        return inc(f"count_mismatch:tests={counts['tests']},baseline={baseline_total}")
    if counts["skipped"] or counts["todo"] or counts["cancelled"]:
        return inc(f"unexpected_skip_todo_cancelled:skipped={counts['skipped']},todo={counts['todo']},"
                   f"cancelled={counts['cancelled']}")
    infra_f = [f for f in failures if f.get("kind") in INFRA_KINDS]
    if infra_f:
        return inc("infra_failure:" + ";".join(f"{f['kind']}:{f.get('test_id', '?')[:60]}" for f in infra_f)[:240])
    if any(f.get("kind") not in (ASSERTION, ERROR, SUBTESTS) for f in failures):
        return inc("unknown_failure_kind")
    real = [f for f in failures if f.get("kind") != SUBTESTS]
    non_suite_fail = [f for f in failures if not f.get("is_suite")]
    if len(non_suite_fail) != counts["fail"]:
        return inc(f"count_inconsistent:fail={counts['fail']},failure_blocks={len(non_suite_fail)}")
    if counts["fail"] == 0:
        if return_code != 0:
            return inc(f"rc_inconsistent:rc={return_code},fail=0")
        if counts["pass"] != baseline_total:
            return inc(f"count_mismatch:pass={counts['pass']},baseline={baseline_total}")
        return _result(SURVIVED, "suite_passed_with_baseline_counts", **base)
    if return_code != 1:
        return inc(f"rc_inconsistent:rc={return_code},fail={counts['fail']}")
    for f in failures:  # a structural parent failure must have a failing descendant
        if f.get("kind") == SUBTESTS:
            pref = f.get("path") or []
            if not any(r.get("path", [])[:len(pref)] == pref and len(r.get("path", [])) > len(pref) for r in real):
                return inc(f"orphan_subtests_failure:{f.get('test_id', '?')[:60]}")

    killing, ids, used, unexpected, sec_hits = [], [], [], [], []
    for f in real:
        hit = None
        if f.get("kind") == ASSERTION:
            for e in expected:  # primary first: a failure matching both counts as primary
                if _path_matches(e["test_pattern"], f) and _label_matches(e.get("assertion_pattern"), f):
                    hit = e
                    break
        if hit and hit["role"] == "primary":
            killing.append(f.get("test_id"))
            ids.append(f.get("assertion_id") or hit.get("assertion_pattern") or hit["test_pattern"])
            continue
        if hit:
            sec_hits.append(f.get("test_id"))
            continue
        al = next((a for a in allowlist if f.get("kind") in set(a.get("kinds") or ALLOWLISTABLE_KINDS)
                   and _path_matches(a["test_pattern"], f) and re.search(a["regex"], f.get("block") or "")), None)
        if al:
            used.append(al["id"])
            continue
        unexpected.append(f"{f.get('kind')}:{(f.get('test_id') or '?')[:60]}")

    def label_outside():
        for e in expected:
            lab = e.get("assertion_pattern")
            if not lab:
                continue
            for p in s.get("points") or []:
                if p.get("ok") and _label_in(lab, p.get("text", "")):
                    return f"{lab}@ok:{p.get('test_id', '?')[:40]}"
            for f in real:
                if f.get("test_id") not in killing and not _path_matches(e["test_pattern"], f) and _label_matches(lab, f):
                    return f"{lab}@other_block:{f.get('test_id', '?')[:40]}"
        return None

    extra = {"killing_tests": sorted(set(killing)), "assertion_ids": sorted(set(map(str, ids))),
             "allowlist_used": sorted(set(used)), "unexpected_failures": unexpected,
             "secondary_tests": sorted(set(sec_hits))}
    if not killing:
        where = label_outside()
        if where:
            return inc("label_outside_block:" + where, **extra)
        if unexpected:
            return inc("unexpected_failure:" + ";".join(unexpected)[:240], **extra)
        if sec_hits:
            return inc("only_secondary_failures:" + ";".join(sorted(set(sec_hits)))[:200], **extra)
        return inc("no_expected_assertion", **extra)
    if unexpected:
        return inc("unexpected_failure:" + ";".join(unexpected)[:240], **extra)
    return _result(KILLED, "primary_assertion:" + ",".join(extra["killing_tests"])[:200]
                   + f" allowlist={','.join(extra['allowlist_used']) or 'none'}", **base, **extra)


# ---------------------------------------------------------------- running and convenience wrappers
def run_command(cmd, cwd=None, timeout=600, env=None):
    """Run a test command; never raises. -> {return_code, stdout, stderr, timed_out, signal, missing_tool}."""
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout)
    except FileNotFoundError as e:
        return {"return_code": 127, "stdout": "", "stderr": f"spawn {cmd[0]} ENOENT ({e})", "timed_out": False,
                "signal": None, "missing_tool": cmd[0]}
    except subprocess.TimeoutExpired as e:
        return {"return_code": None, "stdout": _normalize(e.stdout or b""), "stderr": _normalize(e.stderr or b""),
                "timed_out": True, "signal": None, "missing_tool": None}
    sig = None
    if p.returncode < 0:
        try:
            sig = _signal.Signals(-p.returncode).name
        except ValueError:
            sig = f"SIG{-p.returncode}"
    return {"return_code": p.returncode, "stdout": _normalize(p.stdout), "stderr": _normalize(p.stderr),
            "timed_out": False, "signal": sig, "missing_tool": None}


def classify_run(baseline_total, run, expected=(), allowlist=(), anchor_ok=True, mutant_id=None, extra_infra=()):
    """classify() over a ``run_command`` result (TAP on stdout)."""
    parsed = parse_tap(run.get("stdout", ""), extra_infra=extra_infra, stderr=run.get("stderr", ""))
    if run.get("missing_tool"):
        parsed["summary"]["infra"].insert(0, f"missing_tool:{run['missing_tool']}")
    return classify(baseline_total, run.get("return_code"), parsed["summary"], parsed["failures"], expected,
                    anchor_ok=anchor_ok, timed_out=run.get("timed_out", False), signal=run.get("signal"),
                    allowlist=allowlist, mutant_id=mutant_id)


def validate_baseline(baseline_total, return_code, tap_summary, failures=(), timed_out=False, signal=None):
    """The unmutated suite must classify as SURVIVED with exactly ``baseline_total`` tests. -> {ok, reason, ...}."""
    r = classify(baseline_total, return_code, tap_summary, failures, expected=(), timed_out=timed_out, signal=signal,
                 mutant_id="BASELINE")
    return {**r, "ok": r["verdict"] == SURVIVED}


def aggregate(results, baseline_valid=True):
    """-> (exit_code, summary). 0 all KILLED; 1 any SURVIVED; 2 invalid baseline; 3 any INCONCLUSIVE (2>3>1>0)."""
    results = list(results)
    tally = {v: sum(1 for r in results if r.get("verdict") == v) for v in VERDICTS}
    bad = [r for r in results if r.get("verdict") not in VERDICTS]
    if not baseline_valid:
        code = EXIT_BAD_BASELINE
    elif tally[INCONCLUSIVE] or bad or not results:
        code = EXIT_INCONCLUSIVE
    elif tally[SURVIVED]:
        code = EXIT_SURVIVED
    else:
        code = EXIT_ALL_KILLED
    return code, {"exit_code": code, "baseline_valid": bool(baseline_valid), "mutants": len(results), **tally,
                  "invalid_results": len(bad),
                  "survived": [r.get("mutant_id") for r in results if r.get("verdict") == SURVIVED],
                  "inconclusive": [r.get("mutant_id") for r in results if r.get("verdict") == INCONCLUSIVE]}


# ---------------------------------------------------------------- structured-event adapter (#875 audiovisual gate)
def classify_structured_events(mutant_id, events):
    """Adapter for gates that report per-control decisions instead of TAP (e.g. the #875 AV gate, V8 mutants).

    ``events`` = [{control_id, baseline_correct: bool, mutant_correct: bool, exception: str|None,
    baseline_verdict?, mutant_verdict?}]. A control kills the mutant only when it was classified correctly at
    baseline AND is misclassified under the mutant. Any exception (or an ERROR_INFRA verdict), malformed or duplicate
    event, or a control already wrong at baseline -> INCONCLUSIVE, never KILLED. No kills and no problems -> SURVIVED.
    """
    base = {"mutant_id": mutant_id, "counts": {"controls": 0, "killers": 0}, "source": "structured_events"}
    try:
        events = list(events or [])
        base["counts"]["controls"] = len(events)
        if not events:
            return _result(INCONCLUSIVE, "no_events", **base)
        seen, killers, wrong_at_baseline = set(), [], []
        for ev in events:
            if not isinstance(ev, dict) or not ev.get("control_id"):
                return _result(INCONCLUSIVE, "malformed_event", **base)
            cid = str(ev["control_id"])
            if cid in seen:
                return _result(INCONCLUSIVE, f"duplicate_control:{cid}", **base)
            seen.add(cid)
            if ev.get("exception") or "ERROR_INFRA" in (ev.get("baseline_verdict"), ev.get("mutant_verdict")):
                return _result(INCONCLUSIVE, f"exception:{cid}:{str(ev.get('exception') or 'ERROR_INFRA')[:120]}", **base)
            bc, mc = ev.get("baseline_correct"), ev.get("mutant_correct")
            if not isinstance(bc, bool) or not isinstance(mc, bool):
                return _result(INCONCLUSIVE, f"malformed_event:{cid}", **base)
            if not bc:
                wrong_at_baseline.append(cid)
            elif not mc:
                killers.append(cid)
        if wrong_at_baseline:
            return _result(INCONCLUSIVE, "baseline_misclassified:" + ",".join(wrong_at_baseline)[:200], **base)
        base["counts"]["killers"] = len(killers)
        if killers:
            return _result(KILLED, "baseline_correct_to_mutant_misclassified:" + ",".join(killers)[:200],
                           killing_tests=sorted(killers), **base)
        return _result(SURVIVED, "all_controls_still_correct", **base)
    except Exception as e:  # noqa: BLE001 - the adapter must never let an error look like a kill
        return _result(INCONCLUSIVE, f"adapter_exception:{type(e).__name__}", **base)


# ---------------------------------------------------------------- self-check and CLI
_SELF_TAP = ("TAP version 13\n# Subtest: T1 a\nnot ok 1 - T1 a\n  ---\n  type: 'test'\n  error: 'A1 x'\n"
             "  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  ...\n# Subtest: T10 b\nok 2 - T10 b\n  ---\n"
             "  type: 'test'\n  ...\n1..2\n# tests 2\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n"
             "# todo 0\n# duration_ms 1\n")


def self_check():
    exp = {"primary": [{"test_pattern": "T1", "assertion_pattern": "A1"}]}
    checks = []
    p = parse_tap(_SELF_TAP)
    checks.append(("killed", classify(2, 1, p["summary"], p["failures"], exp)["verdict"] == KILLED))
    p = parse_tap(_SELF_TAP.replace("\n", "\r\n"))
    checks.append(("killed_crlf", classify(2, 1, p["summary"], p["failures"], exp)["verdict"] == KILLED))
    p = parse_tap(_SELF_TAP)
    checks.append(("prefix_T10", classify(2, 1, p["summary"], p["failures"],
                                          {"primary": [{"test_pattern": "T10", "assertion_pattern": "A1"}]})["verdict"] == INCONCLUSIVE))
    sec = {"primary": [{"test_pattern": "T2", "assertion_pattern": "A2"}],
           "secondary": [{"test_pattern": "T1", "assertion_pattern": "A1", "justification": "self-check"}]}
    checks.append(("only_secondary", classify(2, 1, p["summary"], p["failures"], sec)["verdict"] == INCONCLUSIVE))
    try:
        load_mutant_config({"m": {"primary": exp["primary"], "secondary": [{"test_pattern": "T2"}]}})
        checks.append(("unjustified_secondary_refused", False))
    except ConfigError:
        checks.append(("unjustified_secondary_refused", True))
    p = parse_tap(_SELF_TAP[: len(_SELF_TAP) // 2])
    checks.append(("truncated", classify(2, 1, p["summary"], p["failures"], exp)["verdict"] == INCONCLUSIVE))
    clean = _SELF_TAP.replace("not ok 1 - T1 a", "ok 1 - T1 a").replace("# pass 1\n# fail 1", "# pass 2\n# fail 0")
    p = parse_tap(clean)
    checks.append(("survived", classify(2, 0, p["summary"], p["failures"], exp)["verdict"] == SURVIVED))
    checks.append(("timeout", classify(2, 1, p["summary"], p["failures"], exp, timed_out=True)["verdict"] == INCONCLUSIVE))
    checks.append(("av_exception", classify_structured_events("m", [{"control_id": "c", "baseline_correct": True,
                   "mutant_correct": False, "exception": "boom"}])["verdict"] == INCONCLUSIVE))
    for name, ok in checks:
        print(f"MUTANT_CLASSIFIER_SELF_CHECK {name} {'PASS' if ok else 'FAIL'}")
    return 0 if all(ok for _, ok in checks) else 1


def _load_json_arg(v, default):
    if v is None:
        return default
    if v.startswith("@"):
        with open(v[1:], encoding="utf-8") as fh:
            return json.load(fh)
    return json.loads(v)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Shared mutation-test classifier (see module docstring).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("classify", help="classify one mutant run from a TAP file; prints one JSON line")
    c.add_argument("--baseline-total", type=int, required=True)
    c.add_argument("--rc", type=int)
    c.add_argument("--tap", required=True)
    c.add_argument("--stderr")
    c.add_argument("--expected", required=True, help='JSON {"primary":[...],"secondary":[...]} or @file')
    c.add_argument("--allowlist", help="JSON list or @file")
    c.add_argument("--anchor-not-unique", action="store_true")
    c.add_argument("--timed-out", action="store_true")
    c.add_argument("--signal")
    c.add_argument("--mutant-id")
    c.add_argument("--baseline", action="store_true", help="validate a baseline run instead (exit 2 if invalid)")
    a = sub.add_parser("aggregate", help="aggregate JSON Lines results; exit 0/1/2/3")
    a.add_argument("results")
    a.add_argument("--baseline-invalid", action="store_true")
    sub.add_parser("self-check")
    args = ap.parse_args(argv)
    if args.cmd == "self-check":
        return self_check()
    if args.cmd == "aggregate":
        with open(args.results, encoding="utf-8") as fh:
            rows = [json.loads(ln) for ln in fh if ln.strip()]
        code, summary = aggregate(rows, baseline_valid=not args.baseline_invalid)
        print(json.dumps(summary, ensure_ascii=False))
        return code
    with open(args.tap, "rb") as fh:
        tap = fh.read()
    err = ""
    if args.stderr:
        with open(args.stderr, "rb") as fh:
            err = fh.read()
    parsed = parse_tap(tap, stderr=err)
    if args.baseline:
        r = validate_baseline(args.baseline_total, args.rc, parsed["summary"], parsed["failures"],
                              timed_out=args.timed_out, signal=args.signal)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r["ok"] else EXIT_BAD_BASELINE
    r = classify(args.baseline_total, args.rc, parsed["summary"], parsed["failures"],
                 _load_json_arg(args.expected, {}), anchor_ok=not args.anchor_not_unique, timed_out=args.timed_out,
                 signal=args.signal, allowlist=_load_json_arg(args.allowlist, []), mutant_id=args.mutant_id)
    print(json.dumps(r, ensure_ascii=False))
    return aggregate([r])[0]


if __name__ == "__main__":
    sys.exit(main())
