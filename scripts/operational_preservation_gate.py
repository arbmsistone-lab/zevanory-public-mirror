#!/usr/bin/env python3
from __future__ import annotations
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASELINE = ROOT / "evidence" / "operational-baseline.json"
SHA40 = re.compile(r"^[0-9a-f]{40}$")

def main() -> int:
    try:
        b = json.loads(BASELINE.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"FAIL: operational baseline invalid: {exc}")
        return 2

    if b.get("policy") != "ZEVANORY_OPERATIONAL_PRESERVATION_V1":
        print("FAIL: preservation policy mismatch")
        return 2
    if not SHA40.fullmatch(str(b.get("baseline_sha", ""))):
        print("FAIL: baseline SHA invalid")
        return 2
    status = b.get("status", {})
    expected = {
        "zees16": "16/16_PROVEN",
        "zea10": "10/10_PROVEN",
        "p14_provider_independence": "SUCCESS",
    }
    if status != expected:
        print(f"FAIL: baseline status mismatch: {status}")
        return 2
    runs = b.get("proof_runs", {})
    for key in ("p14_run_id","zea10_run_id","zees16_run_id","product_pages_run_id"):
        if not isinstance(runs.get(key), int) or runs[key] <= 0:
            print(f"FAIL: invalid proof run id: {key}")
            return 2
    if b.get("preservation_rule") != "Any pull request targeting gh-pages must re-run and pass ZEES-16, ZEA-10 and P14 before merge.":
        print("FAIL: preservation rule mismatch")
        return 2

    print(f"OPERATIONAL BASELINE: PASS ({b['baseline_sha']})")
    return 0

if __name__ == "__main__":
    sys.exit(main())
