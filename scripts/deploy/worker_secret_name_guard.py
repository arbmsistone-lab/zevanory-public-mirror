#!/usr/bin/env python3
"""R111: fail-closed read of Cloudflare Worker secret NAMES, never values."""
import argparse
import json
import sys

REQUIRED = frozenset(("ADMIN_AUTH_MODE", "ADMIN_PASSPHRASE", "SESSION_SIGNING_KEY"))


def check(payload: object) -> tuple[bool, str]:
    if not isinstance(payload, dict) or payload.get("success") is not True:
        return False, "API_INVALID_OR_UNAVAILABLE"
    items = payload.get("result")
    if not isinstance(items, list):
        return False, "SECRET_LIST_NOT_AN_ARRAY"
    names = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            return False, "SECRET_LIST_INVALID_ENTRY"
        names.add(item["name"])
    missing = REQUIRED - names
    return (False, "MISSING_REQUIRED_SECRET_NAMES:" + ",".join(sorted(missing))) if missing else (True, "REQUIRED_SECRET_NAMES_PRESENT")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    args = p.parse_args()
    try:
        with open(args.input, "r", encoding="utf-8") as f:
            payload = json.load(f)
        ok, reason = check(payload)
    except (OSError, ValueError):
        ok, reason = False, "READ_OR_JSON_ERROR"
    print("ZPC_R111_WORKER_SECRET_NAMES=" + ("PASS" if ok else "FAIL") + " reason=" + reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
