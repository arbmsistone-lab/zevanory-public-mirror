#!/usr/bin/env python3
"""R103: build/validate a Cloudflare Workers deployment rollback request (offline)."""
import argparse
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sys
from uuid import UUID


class SnapshotError(ValueError):
    pass


def rollback_payload(response):
    if not isinstance(response, dict) or response.get("success") is not True:
        raise SnapshotError("cloudflare_deployments_response_not_success")
    result = response.get("result")
    deployments = result.get("deployments") if isinstance(result, dict) else result
    if not isinstance(deployments, list):
        raise SnapshotError("cloudflare_deployments_list_invalid")
    if not deployments:
        return None
    previous = deployments[0]
    if not isinstance(previous, dict) or not isinstance(previous.get("versions"), list) or not previous["versions"]:
        raise SnapshotError("previous_versions_missing")
    versions = []
    total = Decimal(0)
    seen = set()
    for version in previous["versions"]:
        if not isinstance(version, dict):
            raise SnapshotError("version_not_object")
        raw_id = version.get("version_id")
        try:
            identifier = str(UUID(str(raw_id)))
        except (ValueError, AttributeError, TypeError):
            raise SnapshotError("version_id_invalid") from None
        if identifier in seen:
            raise SnapshotError("duplicate_version_id")
        seen.add(identifier)
        raw_percentage = version.get("percentage")
        if isinstance(raw_percentage, bool) or not isinstance(raw_percentage, (int, float, str, Decimal)):
            raise SnapshotError("percentage_invalid")
        try:
            percentage = Decimal(str(raw_percentage))
        except InvalidOperation:
            raise SnapshotError("percentage_invalid") from None
        if not percentage.is_finite() or not Decimal("0.01") <= percentage <= Decimal("100"):
            raise SnapshotError("percentage_out_of_range")
        if percentage % Decimal("0.001") != 0:
            raise SnapshotError("percentage_precision_invalid")
        total += percentage
        versions.append({"version_id": identifier, "percentage": float(percentage)})
    if total != 100:
        raise SnapshotError("percentage_total_not_100")
    return {
        "strategy": "percentage",
        "versions": versions,
        "annotations": {"workers/message": "automatic ZEVANORY SALES rollback snapshot"},
    }


def validate_payload(body):
    if not isinstance(body, dict) or set(body) != {"strategy", "versions", "annotations"}:
        raise SnapshotError("rollback_payload_keys_invalid")
    if body.get("strategy") != "percentage":
        raise SnapshotError("rollback_strategy_invalid")
    return rollback_payload({"success": True, "result": {"deployments": [{"versions": body["versions"]}]}})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", help="Cloudflare GET deployments response file")
    parser.add_argument("--output", help="rollback request output path")
    parser.add_argument("--validate", help="previously generated rollback request file")
    args = parser.parse_args()
    try:
        if args.validate and not (args.snapshot or args.output):
            original = json.loads(Path(args.validate).read_text(encoding="utf-8"))
            validate_payload(original)
            print("ROLLBACK_PAYLOAD_SCHEMA=PASS")
            return 0
        if not (args.snapshot and args.output) or args.validate:
            parser.error("use --snapshot with --output, or --validate")
        body = rollback_payload(json.loads(Path(args.snapshot).read_text(encoding="utf-8")))
        if body is None:
            Path(args.output).write_text("", encoding="utf-8")
            print("PREVIOUS_DEPLOYMENT_SNAPSHOT=NONE_FIRST_RELEASE")
        else:
            validate_payload(body)
            Path(args.output).write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
            print("PREVIOUS_DEPLOYMENT_SNAPSHOT=PASS")
            print("ROLLBACK_PAYLOAD_SCHEMA=PASS")
        return 0
    except (OSError, json.JSONDecodeError, SnapshotError) as exc:
        if args.output:
            Path(args.output).write_text("", encoding="utf-8")
        print("ROLLBACK_SNAPSHOT_INVALID=" + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
