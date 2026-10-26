#!/usr/bin/env python3
"""Causal mutants for the R4 guard scripts/ci/no_forged_production_input.py, classified by the SHARED classifier
scripts/ci/mutant_classifier.py (used unmodified, following its docstring).

Each mutant edits a temporary COPY of the scanner (exact, unique anchor; a missing or repeated anchor is reported as
anchor_ok=False -> INCONCLUSIVE, never skipped) and runs tests/test_no_forged_production_input.py against it through
NFPI_SCRIPT. The tests run under a small TAP emitter (``--tap``) that prints node-style TAP (one point per test, YAML
block with error/name/code), so the classifier's parser, exact counts and infra detection apply unchanged.

Expectations were written by reasoning about which rule each mutation breaks and which labelled assertions encode
that rule, BEFORE running the mutants (see the per-mutant comments). Baseline total is pinned below.
Exit code: the classifier's aggregate (0 all KILLED; 1 SURVIVED; 2 bad baseline; 3 INCONCLUSIVE).
Usage: python3 scripts/ci/mutants_no_forged_production_input.py [--jsonl OUT]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
import traceback
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import mutant_classifier as mc  # noqa: E402  (shared classifier, unmodified)

SCANNER = REPO / "scripts/ci/no_forged_production_input.py"
TEST_MODULE = "tests.test_no_forged_production_input"
BASELINE_TOTAL = 25


def P(test, label):
    return {"test_pattern": test, "assertion_pattern": label}


def S(test, label, why):
    return {"test_pattern": test, "assertion_pattern": label, "justification": why}


# mutant id -> (anchor, replacement, expectations)
MUTANTS = {
    # Signature-header detection off: every case whose ONLY or asserted signal is a signature header fails.
    "M01_signature_headers_ignored": (
        'SIG_HEADER_RE = re.compile(\n    r"(?<![\\w-])', 'SIG_HEADER_RE = re.compile(\n    r"(?!)(?<![\\w-])',
        {"primary": [P("NF17", "NF17a"), P("NF01", "NF01b"), P("NF02", "NF02a")],
         "secondary": [S("NF09", "NF09a", "the production broker line is flagged only by its x-signature header"),
                       S("NF13", "NF13a", "R4-UNRESOLVED requires a signature header or an HMAC; the fixture has a header"),
                       S("NF20", "NF20a", "without the signature hit only the allowable INBOUND hit remains on that line")],
         "broad_reason": "signature headers are a cross-cutting signal: five tests assert it on different fixtures"}),
    # Inbound-path detection off: every unsigned inbound POST disappears, the allow-listed fixture hit becomes stale.
    "M02_inbound_paths_ignored": (
        '        inbound = sorted({s.lower() for s in INBOUND_RE.findall(path_part(url_full))})', '        inbound = []',
        {"primary": [P("NF15", "NF15a"), P("NF01", "NF01c"), P("NF02", "NF02b")],
         "secondary": [S("NF07", "NF07a", "the wrapper fixture is an unsigned POST to /api/internal: INBOUND only"),
                       S("NF08", "NF08a", "the env-tainted fixture asserts R4-INBOUND on /api/internal"),
                       S("NF16", "NF16a", "curl -d to /api/internal is flagged only as INBOUND, so no hit remains"),
                       S("NF11", "NF11a", "the allow-listed /api/internal hit vanishes, the entry turns stale, rc 2"),
                       S("NF24", "NF24a", "the unsigned control-plane POST is flagged only as R4-INBOUND")],
         "broad_reason": "inbound paths are the main R4 signal: seven tests depend on them"}),
    # Subdomains of zevanory.api.br no longer production (edge., controle.).
    "M03_subdomains_not_production": (
        'r"(?<![\\w.-])(?:[a-z0-9-]+\\.)*zevanory\\.api\\.br(?![\\w-])"', 'r"(?<![\\w.-])zevanory\\.api\\.br(?![\\w-])"',
        {"primary": [P("NF01", "NF01a")],
         "secondary": [S("NF00", "NF00a", "the exit-code fixture posts to edge.zevanory.api.br"),
                       S("NF17", "NF17a", "the signed-only fixture posts to controle.zevanory.api.br"),
                       S("NF24", "NF24a", "the control-plane fixture posts to controle.zevanory.api.br")],
         "broad_reason": "subdomain hosts are used by four fixtures (edge, controle twice)"}),
    # Production workers.dev names dropped.
    "M04_production_workers_dev_dropped": (
        '\n    r"|(?<![\\w.-])(?!zevanory-certification\\.)(?:[a-z0-9-]+\\.)+(?:girolocal-rb|zevanory)\\.workers\\.dev(?![\\w-])"',
        '',
        {"primary": [P("NF09", "NF09a")]}),
    # Isolated certification Worker treated as production.
    "M05_certification_worker_is_production": (
        '(?!zevanory-certification\\.)', '',
        {"primary": [P("NF09", "NF09b")]}),
    # GET/HEAD treated as mutating.
    "M06_get_is_mutating": (
        'MUTATING = {"POST", "PUT", "PATCH", "DELETE", "UNKNOWN"}',
        'MUTATING = {"POST", "PUT", "PATCH", "DELETE", "UNKNOWN", "GET", "HEAD"}',
        {"primary": [P("NF03", "NF03a")],
         "secondary": [S("NF07", "NF07a", "the GET call site cert('status') on /api/internal becomes a hit")]}),
    # curl -d no longer implies POST.
    "M07_curl_data_not_post": (
        '--json|--form(?:-string)?)(?![\\w-])", cmd):\n        return "POST"',
        '--json|--form(?:-string)?)(?![\\w-])", cmd):\n        return "GET"',
        {"primary": [P("NF16", "NF16a")]}),
    # fetch literal method ignored (POST read as GET).
    "M08_fetch_method_ignored": (
        'm = re.search(r"\\bmethod\\s*:\\s*[\'\\"`](\\w+)[\'\\"`]", opts)\n    if m:\n        return m.group(1).upper()',
        'm = re.search(r"\\bmethod\\s*:\\s*[\'\\"`](\\w+)[\'\\"`]", opts)\n    if m:\n        return "GET"',
        {"primary": [P("NF02", "NF02a")],
         "secondary": [S("NF06", "NF06a", "the HMAC fixture is also a fetch with a literal POST method")]}),
    # Workflows no longer followed into the scripts they run.
    "M09_scripts_not_followed": (
        '        for no in sorted(run_blocks(text)):', '        for no in []:',
        {"primary": [P("NF05", "NF05a")],
         "secondary": [S("NF07", "NF07a", "the wrapper fixture lives in a script the workflow runs"),
                       S("NF08", "NF08a", "the env-tainted fixture lives in a script the workflow runs")]}),
    # Syntax checks (node --check) followed as if executed.
    "M10_syntax_check_followed": (
        '                if NOT_EXECUTED_RE.search(cmd + " "):\n                    continue\n                r = _resolve_path(m.group(1), root, base_dir, True)',
        '                r = _resolve_path(m.group(1), root, base_dir, True)',
        {"primary": [P("NF10", "NF10a")]}),
    # Workflow env URLs no longer taint invoked scripts.
    "M11_env_taint_ignored": (
        '        taint = workflow_env_taint(text)', '        taint = set()',
        {"primary": [P("NF08", "NF08a")]}),
    # Helper-function indirection not resolved.
    "M12_wrappers_not_resolved": (
        '    synthetic, wrapped = synthesize_wrappers(text, base_reqs, resolver)', '    synthetic, wrapped = [], set()',
        {"primary": [P("NF07", "NF07a")]}),
    # HMAC proximity rule off.
    "M13_hmac_proximity_off": (
        'HMAC_WINDOW = 60', 'HMAC_WINDOW = -1',
        {"primary": [P("NF06", "NF06a")]}),
    # Stale allow-list entries tolerated.
    "M14_stale_allow_tolerated": (
        '    if stale:\n        raise ScanError("stale', '    if False:\n        raise ScanError("stale',
        {"primary": [P("NF11", "NF11b")]}),
    # Unjustified allow-list entries accepted.
    "M15_vague_purpose_accepted": (
        '_need(_text(e["purpose"], 40),', '_need(_text(e["purpose"], 1),',
        {"primary": [P("NF11", "NF11c")]}),
    # Empty workflow set accepted.
    "M16_no_workflows_accepted": (
        '    if not wfs:\n        raise ScanError(f"no workflows found under {wf_dir}")', '    if not wfs:\n        return [], {}',
        {"primary": [P("NF12", "NF12a")]}),
    # Unresolved-target rule removed.
    "M17_unresolved_rule_removed": (
        '        elif (signed or near_hmac) and file_names_prod', '        elif False and (signed or near_hmac) and file_names_prod',
        {"primary": [P("NF13", "NF13a")]}),
    # obj.fetch(...) (in-process worker.fetch) counted as a network request.
    "M18_in_process_fetch_counted": (
        'r"(?:(?<![\\w.$])|(?<=globalThis\\.)|(?<=window\\.)|(?<=self\\.))fetch\\s*\\("', 'r"fetch\\s*\\("',
        {"primary": [P("NF14", "NF14a")]}),
    # Allow-list entry matched regardless of file.
    "M19_allow_ignores_file": (
        'if e["file"] == h["file"] and re.search(e["line_pattern"], line)\n                   and h["rule"]',
        'if re.search(e["line_pattern"], line)\n                   and h["rule"]',
        {"primary": [P("NF11", "NF11d")]}),
    # CLI exit code no longer fails on hits.
    "M20_exit_code_zero": (
        '    return 1 if remaining else 0', '    return 0',
        {"primary": [P("NF00", "NF00a")],
         "secondary": [S("NF22", "NF22a", "an ungated open risk is reported only through the exit code"),
                       S("NF20", "NF20a", "the signed hit that stays unallowed is reported only through the exit code")]}),
    # Sol R4 allow-list conditions and independent gates.
    "M21_endpoint_binding_removed": (
        '\n                   and e["endpoint"] in h.get("url_path", "")), None)', '), None)',
        {"primary": [P("NF18", "NF18a")]}),
    "M22_method_binding_removed": (
        'and h["rule"] in ALLOWABLE_RULES and h["method"] == e["method"]', 'and h["rule"] in ALLOWABLE_RULES',
        {"primary": [P("NF18", "NF18b")]}),
    "M23_signed_hits_allowable": (
        'and h["rule"] in ALLOWABLE_RULES and h["method"]', 'and h["method"]',
        {"primary": [P("NF20", "NF20a")]}),
    "M24_commercial_effects_accepted": (
        'set(eff) == EFFECT_KEYS and all(v is False for v in eff.values()),', 'set(eff) == EFFECT_KEYS,',
        {"primary": [P("NF19", "NF19b")]}),
    "M25_gate_verification_off": (
        '    p = Path(root) / workflow\n    if not p.is_file():', '    return []\n    p = Path(root) / workflow\n    if not p.is_file():',
        {"primary": [P("NF21", "NF21b"), P("NF21", "NF21e")],
         "secondary": [S("NF22", "NF22a", "open-risk gates use the same verifier, so the ungated case passes")]}),
    "M26_open_risk_accepted_inline": (
        '_acceptance(e, w, {"NOT_ACCEPTED"})', '_acceptance(e, w, {"NOT_ACCEPTED", "ACCEPTED"})',
        {"primary": [P("NF22", "NF22d")]}),
    "M27_non_idempotent_write_accepted": (
        '_need(not pl["writes"] or pl["idempotent"] is True,', '_need(True,',
        {"primary": [P("NF19", "NF19c")]}),
    "M28_impersonation_accepted": (
        '\n          and _text(idn["credential"], 3) and idn["impersonates"] == [],', '\n          and _text(idn["credential"], 3),',
        {"primary": [P("NF19", "NF19d")]}),
    "M30_backup_policy_unchecked": (
        '    if "/backup" in e["endpoint"] or "backup_policy" in e:\n        validate_backup_policy(e.get("backup_policy"), root, w)', '',
        {"primary": [P("NF23", "NF23a")]}),
    "M31_last_copy_rule_unchecked": (
        'and r["never_delete_last_valid_copy"] is True', '',
        {"primary": [P("NF23", "NF23c")]}),
    "M32_commercial_route_not_inventoried": (
        '|/api/commercial(?![\\w-])', '',
        {"primary": [P("NF24", "NF24a")]}),
    "M29_evidence_unchecked": (
        'all(_evidence_ok(root, x) for x in ev)', 'True',
        {"primary": [P("NF19", "NF19f")]}),
}


# ---------------------------------------------------------------- TAP emitter for the Python suite
def _yaml_str(text):
    text = re.sub(r"\s*\n\s*", " | ", str(text)).strip()[:3000]
    return "'" + text.replace("'", "''") + "'"


def _label(test):
    m = re.match(r"test_(nf\d+)", test._testMethodName)
    return (m.group(1).upper() + " " if m else "") + test._testMethodName


class TapResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.points = []
        self._t0 = 0.0

    def startTest(self, test):
        super().startTest(test)
        self._t0 = time.time()

    def _add(self, test, ok, err=None, directive=None):
        self.points.append((_label(test), ok, err, directive, (time.time() - self._t0) * 1000))

    def addSuccess(self, test):
        super().addSuccess(test)
        self._add(test, True)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._add(test, False, ("AssertionError", "ERR_ASSERTION", str(err[1])))

    def addError(self, test, err):
        super().addError(test, err)
        self._add(test, False, (err[0].__name__, "", "".join(traceback.format_exception_only(err[0], err[1]))))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._add(test, True, None, "SKIP")

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._add(test, True, None, "TODO")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._add(test, False, ("UnexpectedSuccess", "", "unexpected success"))


def tap_main():
    sys.path.insert(0, str(REPO))
    suite = unittest.defaultTestLoader.loadTestsFromName(TEST_MODULE)
    res = TapResult()
    suite.run(res)
    out = ["TAP version 13"]
    counts = {"pass": 0, "fail": 0, "skipped": 0, "todo": 0}
    for i, (name, ok, err, directive, ms) in enumerate(res.points, 1):
        out.append(f"# Subtest: {name}")
        out.append(f"{'ok' if ok else 'not ok'} {i} - {name}" + (f" # {directive}" if directive else ""))
        out += ["  ---", f"  duration_ms: {ms:.3f}", "  type: 'test'"]
        if err:
            out += ["  location: 'tests/test_no_forged_production_input.py'", "  failureType: 'testCodeFailure'",
                    f"  error: {_yaml_str(err[2])}"]
            if err[1]:
                out.append(f"  code: '{err[1]}'")
            out.append(f"  name: '{err[0]}'")
        out.append("  ...")
        key = {"SKIP": "skipped", "TODO": "todo"}.get(directive) or ("pass" if ok else "fail")
        counts[key] += 1
    n = len(res.points)
    out += [f"1..{n}", f"# tests {n}", "# suites 0", f"# pass {counts['pass']}", f"# fail {counts['fail']}",
            "# cancelled 0", f"# skipped {counts['skipped']}", f"# todo {counts['todo']}", "# duration_ms 1"]
    print("\n".join(out))
    return 1 if counts["fail"] else 0


# ---------------------------------------------------------------- runner
def run_suite(script_path):
    env = {**os.environ, "NFPI_SCRIPT": str(script_path), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    return mc.run_command([sys.executable, str(Path(__file__).resolve()), "--tap"], cwd=str(REPO), timeout=300, env=env)


def main(argv):
    jsonl = None
    if "--jsonl" in argv:
        jsonl = Path(argv[argv.index("--jsonl") + 1])
    config = mc.load_mutant_config({mid: spec for mid, (_, _, spec) in MUTANTS.items()})
    original = SCANNER.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    base = run_suite(SCANNER)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    bl = mc.validate_baseline(BASELINE_TOTAL, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    print(json.dumps({"baseline": bl["verdict"], "ok": bl["ok"], "reason": bl["reason"], "counts": bl["counts"]}))
    if not bl["ok"]:
        print(base.get("stdout", "")[-4000:], base.get("stderr", "")[-4000:], file=sys.stderr)
        code, summary = mc.aggregate([], baseline_valid=False)
        print(json.dumps(summary))
        return code
    results = []
    text = original.decode("utf-8")
    for mid, (anchor, repl, _) in MUTANTS.items():
        spec = config[mid]
        ok = text.count(anchor) == 1
        mutated = text.replace(anchor, repl, 1) if ok else text
        with tempfile.TemporaryDirectory() as d:
            copy = Path(d) / "no_forged_production_input.py"
            copy.write_text(mutated, encoding="utf-8")
            run = run_suite(copy)
        res = mc.classify_run(BASELINE_TOTAL, run, expected=spec, allowlist=spec["allowlist"], anchor_ok=ok,
                              mutant_id=mid)
        results.append(res)
        print(json.dumps({k: res.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests",
                                                    "secondary_tests", "unexpected_failures")}))
    if hashlib.sha256(SCANNER.read_bytes()).hexdigest() != digest:
        print("ORIGINAL_SCANNER_MODIFIED", file=sys.stderr)
        return mc.EXIT_INCONCLUSIVE
    if jsonl:
        jsonl.write_text("".join(json.dumps(r) + "\n" for r in results), encoding="utf-8")
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(json.dumps(summary))
    print(f"R4_MUTANTS total={summary['mutants']} killed={summary['KILLED']} survived={summary['SURVIVED']} "
          f"inconclusive={summary['INCONCLUSIVE']} baseline_tests={BASELINE_TOTAL}")
    return code


if __name__ == "__main__":
    if "--tap" in sys.argv:
        sys.exit(tap_main())
    sys.exit(main(sys.argv[1:]))
