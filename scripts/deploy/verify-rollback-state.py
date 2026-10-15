#!/usr/bin/env python3
"""Separates two results the rollback step used to merge (incident C-2026-10-15-40):

  A. ROLLBACK_STATE  — is the PREVIOUS version really serving 100% of traffic?
       COMPLETE    the active Cloudflare deployment (the one with the newest, unique, valid
                   created_on) has exactly ONE version at exactly 100%, its workers/tag is the
                   previous runtime SHA, AND /api/release reports that same SHA
       INCOMPLETE  traffic split (any second version, even at 0%, or a numeric percentage other
                   than exactly 100), or the candidate (or no version) still active
       DIVERGENT   a third version is active, or /api/release disagrees with Cloudflare
       UNVERIFIED  any evidence missing, unreadable, malformed or ambiguous (always with a reason)
  B. HEALTH_STATE — operational health, reported separately:
       HEALTHY                    /api/health 200 with live and ready true
       DEGRADED_PREEXISTING       unhealthy now AND the pre-deploy baseline PROVED degradation
       DEGRADED_NEW               unhealthy now AND the pre-deploy baseline PROVED health
       DEGRADED_UNKNOWN_BASELINE  unhealthy now and the baseline proves neither (never "preexisting")

  Pre-deploy baseline (C-45 D3): HEALTHY only with 200 + live/ready true; DEGRADED_PREEXISTING only
  with 503 + a readable body where ready is literally false; everything else (network failure,
  timeout, 000, other codes, unreadable body) is UNKNOWN.

It never turns a health failure into success: the rollback step still fails, and the financial
proof renewal stays reachable only from the verified-health branch of that step. Read-only.

Usage:
  verify-rollback-state.py PREVIOUS_SHA CANDIDATE_SHA deployments.json version-tags.json \
                           release.json HEALTH_CODE health.json PREDEPLOY_HEALTH
      -> exit 0 only for ROLLBACK_STATE=COMPLETE, otherwise 2 (never a traceback)
  verify-rollback-state.py --predeploy HEALTH_CODE health.json     -> prints the baseline, exit 0
  verify-rollback-state.py --active-versions deployments.json      -> prints the version ids of the
      active deployment, one per line (same selection rule as the classifier), exit 0
"""
import datetime as dt
import json
import math
import re
import sys

SHA = re.compile(r"^[0-9a-f]{40}$")
ISO = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$")
PREDEPLOY_STATES = ("HEALTHY", "DEGRADED_PREEXISTING", "UNKNOWN")


class Evidence(Exception):
    """Evidence is missing, malformed or ambiguous: the result is UNVERIFIED with this reason."""


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        return json.loads(text) if text else None
    except (OSError, ValueError):
        return None


def _when(value):
    m = ISO.match(value) if isinstance(value, str) else None
    if not m:
        raise Evidence("deployment_created_on_invalid")
    base, frac, tz = m.groups()
    stamp = dt.datetime.fromisoformat(base + ("+00:00" if tz == "Z" else tz))
    return stamp.timestamp() + (int(frac.ljust(9, "0")) / 1e9 if frac else 0.0)


def active_deployment(deployments):
    """The deployment with the newest created_on. Any shape problem, invalid date or tie: Evidence."""
    if not isinstance(deployments, dict):
        raise Evidence("cloudflare_deployments_unreadable")
    result = deployments.get("result")
    deps = result.get("deployments") if isinstance(result, dict) else None
    if not isinstance(deps, list) or not deps:
        raise Evidence("cloudflare_deployments_unreadable")
    if not all(isinstance(d, dict) for d in deps):
        raise Evidence("cloudflare_deployment_malformed")
    ranked = sorted(((_when(d.get("created_on")), i) for i, d in enumerate(deps)), reverse=True)
    if len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
        raise Evidence("active_deployment_ambiguous_same_created_on")
    active = deps[ranked[0][1]]
    versions = active.get("versions")
    if versions is None:
        versions = []
    if not isinstance(versions, list) or not all(isinstance(v, dict) for v in versions):
        raise Evidence("cloudflare_versions_malformed")
    for v in versions:
        if not isinstance(v.get("version_id"), str) or not v["version_id"]:
            raise Evidence("cloudflare_version_id_invalid")
        if not _number(v.get("percentage")):
            raise Evidence("cloudflare_percentage_invalid")
    return versions


def _number(p):
    # bool is an int subclass: True must not count as a percentage. Text is not a number.
    return isinstance(p, (int, float)) and not isinstance(p, bool) and math.isfinite(p)


def _exactly_100(p):
    return _number(p) and p == 100  # exact comparison: no int()/round() coercion


def _rollback_state(previous_sha, candidate_sha, deployments, version_tags, release):
    previous_sha = previous_sha.lower() if isinstance(previous_sha, str) else ""
    if not SHA.match(previous_sha):
        raise Evidence("previous_sha_unknown")
    versions = active_deployment(deployments)
    if not versions:
        return "INCOMPLETE", "no_active_version"
    if len(versions) != 1 or not _exactly_100(versions[0].get("percentage")):
        return "INCOMPLETE", "traffic_split:" + ",".join(f"{v['version_id'][:8]}={v.get('percentage')!r}" for v in versions)
    vid = versions[0]["version_id"]
    tag = version_tags.get(vid) if isinstance(version_tags, dict) else None
    tag = tag.lower() if isinstance(tag, str) else ""
    if not SHA.match(tag):
        raise Evidence("active_version_tag_unreadable")
    if tag == (candidate_sha.lower() if isinstance(candidate_sha, str) else ""):
        return "INCOMPLETE", "candidate_still_active"
    if tag != previous_sha:
        return "DIVERGENT", "active_tag_is_neither_previous_nor_candidate:" + tag[:12]
    dep = release.get("deployment") if isinstance(release, dict) else None
    served = dep.get("commit_sha") if isinstance(dep, dict) else None
    served = served.lower() if isinstance(served, str) else ""
    if not SHA.match(served):
        raise Evidence("release_readback_unreadable")
    if served != previous_sha:
        return "DIVERGENT", "readback_disagrees_with_cloudflare:" + served[:12]
    return "COMPLETE", "cloudflare_and_readback_agree:" + previous_sha[:12]


def rollback_state(previous_sha, candidate_sha, deployments, version_tags, release):
    try:
        return _rollback_state(previous_sha, candidate_sha, deployments, version_tags, release)
    except Evidence as e:
        return "UNVERIFIED", str(e)
    except Exception as e:  # noqa: BLE001 — any unexpected shape is missing evidence, never success
        return "UNVERIFIED", "malformed_evidence:" + type(e).__name__


def _healthy(health_code, health):
    return str(health_code) == "200" and isinstance(health, dict) and health.get("live") is True and health.get("ready") is True


def predeploy_state(health_code, health):
    if _healthy(health_code, health):
        return "HEALTHY"
    if str(health_code) == "503" and isinstance(health, dict) and health.get("ready") is False:
        return "DEGRADED_PREEXISTING"
    return "UNKNOWN"


def health_state(health_code, health, predeploy):
    if _healthy(health_code, health):
        return "HEALTHY"
    if predeploy == "DEGRADED_PREEXISTING":
        return "DEGRADED_PREEXISTING"
    if predeploy == "HEALTHY":
        return "DEGRADED_NEW"
    return "DEGRADED_UNKNOWN_BASELINE"


def main(argv):
    if len(argv) == 4 and argv[1] == "--predeploy":
        print(predeploy_state(argv[2], _load(argv[3])))
        return 0
    if len(argv) == 3 and argv[1] == "--active-versions":
        try:
            print("\n".join(v["version_id"] for v in active_deployment(_load(argv[2]))))
        except Exception:  # noqa: BLE001 — no ids: the classifier will report UNVERIFIED
            pass
        return 0
    if len(argv) != 9:
        print(__doc__.split("Usage:")[1], file=sys.stderr)
        return 2
    prev, cand, dep_p, tags_p, rel_p, code, health_p, predeploy = argv[1:]
    try:
        a, why = rollback_state(prev, cand, _load(dep_p), _load(tags_p), _load(rel_p))
        b = health_state(code, _load(health_p), predeploy)
    except Exception as e:  # noqa: BLE001 — last line of defence: still a structured, failing result
        a, why, b = "UNVERIFIED", "classifier_error:" + type(e).__name__, "DEGRADED_UNKNOWN_BASELINE"
    print(f"::{'notice' if a == 'COMPLETE' else 'error'} title=ROLLBACK_STATE::{a} ({why})")
    print(f"::{'notice' if b == 'HEALTHY' else 'warning'} title=HEALTH_STATE::{b}")
    print(f"ROLLBACK_STATE={a}")
    print(f"ROLLBACK_REASON={why}")
    print(f"HEALTH_STATE={b}")
    return 0 if a == "COMPLETE" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
