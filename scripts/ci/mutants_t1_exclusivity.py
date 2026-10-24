#!/usr/bin/env python3
"""Causal mutants of the T1 strict inventory and verdict, classified by the SHARED classifier
scripts/ci/mutant_classifier.py (load_mutant_config, parse_tap, classify_run, aggregate; unmodified).

Each mutant edits a temporary COPY of scripts/deploy/worker_write_paths.py (I*) or
scripts/deploy/t1_exclusivity_verdict.py (V*) and runs tests/t1_exclusivity/t1-exclusivity.test.mjs against it
(T1_WRITE_PATHS_SCRIPT / T1_VERDICT_SCRIPT); the originals are never modified.

Expectations (EXPECTED) were written by reasoning about which rule each mutation breaks and which assertion
markers ([T1-Wnn] / [T1-Vnn]) encode that rule, BEFORE running the mutants; they are not copied from observed
failures. Every primary carries a non-null assertion_pattern (the marker); every secondary has a justification.
KILLED needs a primary marker failing inside its own test block and nothing outside primary + secondary.
Exit (aggregate): 0 all KILLED; 1 any SURVIVED; 2 invalid baseline/config; 3 any INCONCLUSIVE.
Usage: python3 scripts/ci/mutants_t1_exclusivity.py [repo-root]
"""
import json
import os
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
TEST = "tests/t1_exclusivity/t1-exclusivity.test.mjs"
BASELINE_TOTAL = 32
INV, VER = "scripts/deploy/worker_write_paths.py", "scripts/deploy/t1_exclusivity_verdict.py"
ENVVAR = {INV: "T1_WRITE_PATHS_SCRIPT", VER: "T1_VERDICT_SCRIPT"}
NODE = shutil.which("node") or "node"


def P(test, marker):
    return {"test_pattern": test, "assertion_pattern": marker}


def S(test, marker, why):
    return {"test_pattern": test, "assertion_pattern": marker, "justification": why}


# id: (file, old, new, expected)
M = {
    "I1": (INV, 'if production and "code" in kinds and res["unguarded"]:', "if False:",
           {"primary": [P("T1-W06", "T1-W06"), P("T1-W07", "T1-W07"), P("T1-W08", "T1-W08")]}),
    "I2": (INV, "earlier = guard_step is not None and guard_step < idx and step_gated",
           "earlier = guard_step is not None and guard_step < idx",
           {"primary": [P("T1-W08", "T1-W08")]}),
    "I3": (INV, "            g = guard_line(run)\n",
           "            g = guard_line(run) if guard_line(run) is not None else (-1 if any(guard_line(str(x.get('run') or '')) is not None for x in steps) else None)\n",
           {"primary": [P("T1-W07", "T1-W07")],
            "secondary": [S("T1-W08", "T1-W08", "a guard anywhere in the job now counts as an in-step guard placed before the "
                            "write, which also accepts the earlier but ungated guard")]}),
    "I4": (INV, "FOLLOW_DEPTH = 2\n", "FOLLOW_DEPTH = 0\n", {"primary": [P("T1-W02", "T1-W02")]}),
    "I5": (INV, "                if not job_cred:\n                    no_cred.append(", "                if False:\n                    no_cred.append(",
           {"primary": [P("T1-W11", "T1-W11")]}),
    "I6": (INV, "            if WRITE_METHOD.search(line) or (not is_script and", "            if False and (not is_script and",
           {"primary": [P("T1-W03", "T1-W03")],
            "secondary": [S("T1-W14", "T1-W14", "the standalone script carries target and method on one line, the same-line "
                            "branch that the mutation disables"),
                          S("T1-W19", "T1-W19", "the unparseable workflow is scanned as raw text with the same API-write "
                            "detector, so its UNREGISTERED finding disappears")]}),
    "I7": (INV, 'BUILDS_MARKER = re.compile(r"\\bWORKERS_CI(?:_[A-Z_]+)?\\b|\\bRESERVE_DEPLOY\\b")', 'BUILDS_MARKER = re.compile(r"(?!x)x")',
           {"primary": [P("T1-W04", "T1-W04")],
            "secondary": [S("T1-W13", "T1-W13b", "without markers the unguarded reserve is not inventoried, so its finding "
                            "disappears (the guarded half still passes)"),
                          S("T1-W18", "T1-W18", "the repository's Workers Builds reserve row is found by its markers")]}),
    "I8": (INV, '        idx[wf] = {"service": "retired", "role": "retired"}', "        pass",
           {"primary": [P("T1-W10", "T1-W10")]}),
    "I9": (INV, "wrong = [t for t in code_targets if t != svc]", "wrong = []", {"primary": [P("T1-W09", "T1-W09")]}),
    "I10": (INV, 'if m and "--dry-run" not in line and', "if m and", {"primary": [P("T1-W12", "T1-W12")]}),
    "I11": (INV, 'if reg["role"] in ("pending_owner_authorization", "unserialized_known"):', "if False:",
            {"primary": [P("T1-W16", "T1-W16")]}),
    "I12": (INV, 'elif reg["role"] in ("canonical", "config") and not serialized:', "elif False:",
            {"primary": [P("T1-W17", "T1-W17")]}),
    "I13": (INV, '        ops = [dict(o, job="?", step="?") for o in scan_blob(root, text, False)]', "        ops = []",
            {"primary": [P("T1-W19", "T1-W19")]}),
    "I14": (INV, '        if not reg:\n            add("UNREGISTERED_SCRIPT"', '        if not reg:\n            continue\n            add("UNREGISTERED_SCRIPT"',
            {"primary": [P("T1-W14", "T1-W14")]}),
    "I15": (INV, '        if not reg:\n            add("UNREGISTERED", name,', '        if not reg:\n            continue\n            add("UNREGISTERED", name,',
            {"primary": [P("T1-W01", "T1-W01"), P("T1-W02", "T1-W02b"), P("T1-W03", "T1-W03b")],
             "secondary": [S("T1-W19", "T1-W19", "the unparseable workflow is also unregistered; its UNREGISTERED finding is "
                             "the one the mutation drops")]}),
    "V1": (VER, 'if t.get("status") in ("active", "unknown", None):', 'if t.get("status") in ("unknown", None):',
           {"primary": [P("T1-V02", "T1-V02")]}),
    "V2": (VER, 'if t.get("reach") != 1 or t.get("visible") != [w]:', "if False:",
           {"primary": [P("T1-V03", "T1-V03"), P("T1-V13", "T1-V13")]}),
    "V3": (VER, 'elif not limited_to(t["write_policies"], w, account):', "elif False:", {"primary": [P("T1-V03", "T1-V03b")]}),
    "V4": (VER, '        if not t.get("policies_readable"):\n            reasons.append(f"W:', '        if False:\n            reasons.append(f"W:',
           {"primary": [P("T1-V04", "T1-V04")]}),
    "V5": (VER, "if writers != ([own] if own else []):", "if False:", {"primary": [P("T1-V05", "T1-V05")]}),
    "V6": (VER, '        elif not audit_ok:\n            reasons.append(f"S:', '        elif False:\n            reasons.append(f"S:',
           {"primary": [P("T1-V06", "T1-V06")]}),
    "V7": (VER, 'elif ev["inventory_findings"]:', "elif False:", {"primary": [P("T1-V07", "T1-V07")]}),
    "V8": (VER, 'elif tag and rb["sha"] != tag:', "elif False:", {"primary": [P("T1-V08", "T1-V08")]}),
    "V9": (VER, '        if not rb.get("defined"):\n            reasons.append(', '        if False:\n            reasons.append(',
           {"primary": [P("T1-V09", "T1-V09")]}),
    "V10": (VER, 'ev["status"] = "invalid" if av[0] == 401 and uv[0] == 401 else "unknown"', 'ev["status"] = "unknown"',
            {"primary": [P("T1-V10", "T1-V10")]}),
    "V11": (VER, 'if t.get("status") != "active":', 'if t.get("status") not in ("active", "unknown"):',
            {"primary": [P("T1-V11", "T1-V11")]}),
    "V12": (VER, 'if not ev.get("manual_registered"):', "if False:", {"primary": [P("T1-V12", "T1-V12")]}),
    "V13": (VER, '    if not audit.get("configured"):\n        reasons.append(', '    if False:\n        reasons.append(',
            {"primary": [P("T1-V06", "T1-V06b")]}),
    "V14": (VER, 'if r.endswith("*") or r in (f"com.cloudflare.api.account.{account}",) or', 'if r.endswith("*") or',
            {"primary": [P("T1-V05", "T1-V05")]}),
}


def run_suite(env_extra):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **env_extra}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", TEST],
                          cwd=str(REPO), timeout=600, env=env)


def one(item):
    mid, (path, old, new, _spec) = item
    src = (REPO / path).read_text(encoding="utf-8")
    anchor_ok = src.count(old) == 1
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / Path(path).name
        f.write_text(src.replace(old, new, 1) if anchor_ok else src, encoding="utf-8")
        run = run_suite({ENVVAR[path]: str(f)})
    res = mc.classify_run(BASELINE_TOTAL, run, expected=CONFIG[mid], allowlist=CONFIG[mid]["allowlist"],
                          anchor_ok=anchor_ok, mutant_id=mid)
    if res["verdict"] == mc.INCONCLUSIVE and anchor_ok:  # one retry, as the classifier contract allows
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / Path(path).name
            f.write_text(src.replace(old, new, 1), encoding="utf-8")
            res = mc.classify_run(BASELINE_TOTAL, run_suite({ENVVAR[path]: str(f)}), expected=CONFIG[mid],
                                  allowlist=CONFIG[mid]["allowlist"], anchor_ok=True, mutant_id=mid)
    return res


try:
    CONFIG = mc.load_mutant_config({k: v[3] for k, v in M.items()})
    for mid, spec in CONFIG.items():
        if any(not e.get("assertion_pattern") for e in spec["primary"]):
            raise mc.ConfigError(f"{mid}: primary without assertion marker")
except mc.ConfigError as e:
    print(f"MUTANT CONFIG INVALID: {e}")
    sys.exit(mc.EXIT_BAD_BASELINE)

base = run_suite({})
parsed = mc.parse_tap(base["stdout"], stderr=base["stderr"])
bl = mc.validate_baseline(BASELINE_TOTAL, base["return_code"], parsed["summary"], parsed["failures"],
                          timed_out=base["timed_out"], signal=base["signal"])
if not bl["ok"]:
    print(base["stdout"][-3000:])
    print(f"MUTANT BASELINE INVALID: {bl['reason']}")
    sys.exit(mc.EXIT_BAD_BASELINE)
print(f"MUTANT BASELINE PASS tests={BASELINE_TOTAL}", flush=True)
with ThreadPoolExecutor(max_workers=max(2, min(8, os.cpu_count() or 2))) as ex:
    results = list(ex.map(one, M.items()))
for r in results:
    print(json.dumps(r, ensure_ascii=False), flush=True)
    print(f"MUTANT {r['mutant_id']} {r['verdict']} {r['reason'][:160]}", flush=True)
code, summary = mc.aggregate(results, baseline_valid=True)
print(f"MUTANTS total={summary['mutants']} killed={summary['KILLED']} survived={summary['SURVIVED']} "
      f"inconclusive={summary['INCONCLUSIVE']}")
sys.exit(code)
