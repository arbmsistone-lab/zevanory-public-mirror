#!/usr/bin/env python3
"""R106: choose latest Cloudflare deployment by UTC created_on; validate rollback payload offline."""
import argparse
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
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
    # Never trust API list order: the sandbox returned oldest first.
    # Reject any missing/ambiguous timestamp rather than risk restoring an unrelated deployment.
    dated = []
    for deployment in deployments:
        if not isinstance(deployment, dict):
            raise SnapshotError("deployment_not_object")
        stamp = deployment.get("created_on")
        if not isinstance(stamp, str) or not stamp.strip():
            raise SnapshotError("deployment_created_on_missing")
        try:
            dt = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            raise SnapshotError("deployment_created_on_invalid") from None
        if dt.tzinfo is None or dt.utcoffset() is None:
            raise SnapshotError("deployment_created_on_timezone_missing")
        dated.append((dt.astimezone(timezone.utc), deployment))
    latest_at = max(item[0] for item in dated)
    latest = [deployment for dt, deployment in dated if dt == latest_at]
    if len(latest) != 1:
        raise SnapshotError("deployment_created_on_tie")
    previous = latest[0]
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
    return rollback_payload({"success": True, "result": {"deployments": [{"created_on": "2000-01-01T00:00:00Z", "versions": body["versions"]}]}})


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
