#!/usr/bin/env python3
"""Pre-promotion guard shared by every ZEVANORY publisher (plan 3.1, T1).

Decides, immediately before a production promotion and inside the service's serialized
concurrency group, whether the candidate may be published:

  promote          candidate is the live SHA or a descendant of it (forward or same)
  skip-superseded  candidate is an ancestor of what is live (an older queued run): do nothing
  refuse           histories diverged, or production is unreadable and the candidate is not
                   the current branch tip; also any backwards move without an authorised rollback

"Live" is read from two independent sources when available:
  1. the Cloudflare active deployment of the script (version annotation workers/tag), and
  2. an HTTP readback of the running service (JSON field with the deployed commit).
If both are readable they must agree, otherwise the decision is refuse (the effective
deployment is not what the public surface reports).

Rollback is never automatic here: it requires ROLLBACK_AUTHORISED=true plus a reason of at
least 20 characters, and is reported as `promote-rollback` for the audit trail.

Usage:
  promotion_guard.py --service zevanory --candidate <sha> --branch-tip <sha>
                     [--readback-url URL --readback-path deployment.commit_sha]
                     [--cloudflare-script zevanory]
Writes `decision`, `live_sha` and `reason` to $GITHUB_OUTPUT when present.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

SHA = re.compile(r"^[0-9a-f]{40}$")


def _get(url: str, headers: dict | None = None, timeout: int = 20):
    req = urllib.request.Request(url, headers={"user-agent": "ZEVANORY-promotion-guard/1", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (fixed https hosts)
        return json.loads(resp.read().decode("utf-8"))


def _dig(obj, path: str):
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def norm(value) -> str | None:
    text = str(value or "").strip().lower()
    return text if SHA.match(text) else None


def readback_sha(url: str | None, path: str | None, fetch=_get) -> str | None:
    if not url or not path:
        return None
    try:
        return norm(_dig(fetch(url), path))
    except Exception:
        return None


def cloudflare_sha(script: str | None, fetch=_get) -> str | None:
    """SHA tagged on the version that currently serves 100% of the script's traffic."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not script or not token or not account:
        return None
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{script}"
    auth = {"Authorization": f"Bearer {token}"}
    try:
        deployments = (fetch(base + "/deployments", auth).get("result") or {}).get("deployments") or []
        if not deployments:
            return None
        versions = deployments[0].get("versions") or []
        full = [v for v in versions if int(v.get("percentage") or 0) == 100]
        if len(full) != 1:
            return None  # gradual rollout or unknown: not a single effective version
        version = fetch(f"{base}/versions/{full[0].get('version_id')}", auth).get("result") or {}
        annotations = (version.get("metadata") or {}).get("annotations") or version.get("annotations") or {}
        return norm(annotations.get("workers/tag"))
    except Exception:
        return None


def is_ancestor(older: str, newer: str, repo: str) -> bool:
    return subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", older, newer],
                          capture_output=True).returncode == 0


def decide(candidate: str, branch_tip: str | None, live_http: str | None, live_cf: str | None,
           ancestor, rollback_ok: bool) -> tuple[str, str | None, str]:
    candidate = norm(candidate) or ""
    if not candidate:
        return "refuse", None, "candidate_sha_invalid"
    if live_http and live_cf and live_http != live_cf:
        return "refuse", None, f"effective_deployment_mismatch:cloudflare={live_cf[:12]}:readback={live_http[:12]}"
    live = live_cf or live_http
    if not live:
        # Unreadable production is not permission to move backwards: only the branch tip
        # (controlled recovery) may be published.
        if branch_tip and candidate == norm(branch_tip):
            return "promote", None, "production_unreadable_branch_tip_recovery"
        return "refuse", None, "production_unreadable_candidate_not_branch_tip"
    if candidate == live:
        return "promote", live, "same_as_live_redeploy"
    if ancestor(live, candidate):
        return "promote", live, "forward_of_live"
    if ancestor(candidate, live):
        if rollback_ok:
            return "promote-rollback", live, "authorised_rollback"
        return "skip-superseded", live, "candidate_older_than_live"
    if rollback_ok:
        return "promote-rollback", live, "authorised_rollback_diverged"
    return "refuse", live, "histories_diverged"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", required=True)
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--branch-tip")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--readback-url")
    ap.add_argument("--readback-path")
    ap.add_argument("--cloudflare-script")
    args = ap.parse_args(argv)

    reason_text = os.environ.get("ROLLBACK_REASON", "").strip()
    rollback_ok = os.environ.get("ROLLBACK_AUTHORISED", "") == "true" and len(reason_text) >= 20
    live_http = readback_sha(args.readback_url, args.readback_path)
    live_cf = cloudflare_sha(args.cloudflare_script)
    decision, live, reason = decide(args.candidate, args.branch_tip, live_http, live_cf,
                                    lambda a, b: is_ancestor(a, b, args.repo), rollback_ok)
    record = {"service": args.service, "candidate": args.candidate, "branch_tip": args.branch_tip,
              "live_cloudflare": live_cf, "live_readback": live_http, "decision": decision, "reason": reason}
    print("PROMOTION_GUARD=" + json.dumps(record, sort_keys=True))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"decision={decision}\nlive_sha={live or ''}\nreason={reason}\n")
    level = "error" if decision == "refuse" else "notice"
    print(f"::{level} title=PROMOTION_GUARD_{args.service}::{decision} ({reason})")
    return 1 if decision == "refuse" else 0


if __name__ == "__main__":
    sys.exit(main())
