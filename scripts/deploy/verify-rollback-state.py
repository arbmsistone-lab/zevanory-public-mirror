#!/usr/bin/env python3
"""Separates two results the rollback step used to merge (incident C-2026-10-15-40):

  A. ROLLBACK_STATE  — is the PREVIOUS version really serving 100% of traffic?
       COMPLETE    Cloudflare active deployment = ONE version at 100% whose workers/tag is the
                   previous runtime SHA, AND /api/release reports that same SHA
       INCOMPLETE  traffic split, or the candidate (or no version) still active
       DIVERGENT   a third version is active, or /api/release disagrees with Cloudflare
       UNVERIFIED  Cloudflare or /api/release unreadable, or the previous SHA unknown
  B. HEALTH_STATE — operational health, reported separately:
       HEALTHY               /api/health 200 with live and ready true
       DEGRADED_PREEXISTING  unhealthy now AND already degraded before this deploy
       DEGRADED_NEW          unhealthy now and healthy (or unknown) before this deploy

It never turns a health failure into success: the rollback step still fails, and the financial
proof renewal stays reachable only from the verified-health branch of that step. Read-only.
Exit code: 0 only for COMPLETE (A); any other A state exits 2.
"""
import json
import re
import sys

SHA = re.compile(r"^[0-9a-f]{40}$")


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        return json.loads(text) if text else None
    except (OSError, ValueError):
        return None


def rollback_state(previous_sha, candidate_sha, deployments, version_tags, release):
    previous_sha = (previous_sha or "").lower()
    if not SHA.match(previous_sha):
        return "UNVERIFIED", "previous_sha_unknown"
    deps = ((deployments or {}).get("result") or {}).get("deployments") if isinstance(deployments, dict) else None
    if not deps:
        return "UNVERIFIED", "cloudflare_deployments_unreadable"
    active = max(deps, key=lambda d: str(d.get("created_on", "")))
    versions = active.get("versions") or []
    if not versions:
        return "INCOMPLETE", "no_active_version"
    if len(versions) != 1 or int(versions[0].get("percentage") or 0) != 100:
        return "INCOMPLETE", "traffic_split:" + ",".join(f"{v.get('version_id', '?')[:8]}={v.get('percentage')}" for v in versions)
    vid = versions[0].get("version_id")
    tag = str((version_tags or {}).get(vid) or "").lower()
    if not SHA.match(tag):
        return "UNVERIFIED", "active_version_tag_unreadable"
    if tag == (candidate_sha or "").lower():
        return "INCOMPLETE", "candidate_still_active"
    if tag != previous_sha:
        return "DIVERGENT", "active_tag_is_neither_previous_nor_candidate:" + tag[:12]
    served = str((((release or {}).get("deployment") or {}).get("commit_sha")) or "").lower() if isinstance(release, dict) else ""
    if not SHA.match(served):
        return "UNVERIFIED", "release_readback_unreadable"
    if served != previous_sha:
        return "DIVERGENT", "readback_disagrees_with_cloudflare:" + served[:12]
    return "COMPLETE", "cloudflare_and_readback_agree:" + previous_sha[:12]


def health_state(health_code, health, predeploy):
    ok = str(health_code) == "200" and isinstance(health, dict) and health.get("live") is True and health.get("ready") is True
    if ok:
        return "HEALTHY"
    return "DEGRADED_PREEXISTING" if predeploy == "DEGRADED_PREEXISTING" else "DEGRADED_NEW"


def main(argv):
    if len(argv) != 9:
        print("usage: verify-rollback-state.py PREVIOUS_SHA CANDIDATE_SHA deployments.json version-tags.json release.json HEALTH_CODE health.json PREDEPLOY_HEALTH", file=sys.stderr)
        return 2
    prev, cand, dep_p, tags_p, rel_p, code, health_p, predeploy = argv[1:]
    a, why = rollback_state(prev, cand, _load(dep_p), _load(tags_p), _load(rel_p))
    b = health_state(code, _load(health_p), predeploy)
    level = "notice" if a == "COMPLETE" else "error"
    print(f"::{level} title=ROLLBACK_STATE::{a} ({why})")
    print(f"::{'notice' if b == 'HEALTHY' else 'warning'} title=HEALTH_STATE::{b}")
    print(f"ROLLBACK_STATE={a}")
    print(f"HEALTH_STATE={b}")
    return 0 if a == "COMPLETE" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
