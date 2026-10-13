#!/usr/bin/env python3
"""Pre-promotion guard shared by every ZEVANORY publisher (plan 3.1, T1).

Decides, immediately before a production promotion and inside the service's serialized
concurrency group, whether the candidate may be published:

  promote          candidate is the live SHA or a descendant of it (forward or same)
  skip-superseded  candidate is an ancestor of what is live (an older queued run): do nothing
  refuse           histories diverged, the two sources of the live version disagree, or the
                   effective production version is UNKNOWN (no trustworthy source)

"Live" is read from two independent sources when available:
  1. the Cloudflare active deployment of the script (version annotation workers/tag), and
  2. an HTTP readback of the running service (JSON field with the deployed commit).
If both are readable they must agree, otherwise the decision is refuse (the effective
deployment is not what the public surface reports).

This guard never moves production backwards. A deliberate rollback is a `git revert` merged by
the owner, which is a FORWARD promotion with a reviewed pull request as its authorisation trail.
Recovery when production is unreadable is not automatic: it needs the separate, explicit
procedure documented in ops/publishers.json (owner-dispatched, audited).

Usage:
  promotion_guard.py --service zevanory --candidate <sha>
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


def decide(candidate: str, live_http: str | None, live_cf: str | None, ancestor) -> tuple[str, str | None, str]:
    candidate = norm(candidate) or ""
    if not candidate:
        return "refuse", None, "candidate_sha_invalid"
    if live_http and live_cf and live_http != live_cf:
        return "refuse", None, f"effective_deployment_mismatch:cloudflare={live_cf[:12]}:readback={live_http[:12]}"
    live = live_cf or live_http
    if not live:
        # Unknown effective version: nothing proves the candidate contains what is live.
        return "refuse", None, "production_version_unknown"
    if candidate == live:
        return "promote", live, "same_as_live_redeploy"
    if ancestor(live, candidate):
        return "promote", live, "forward_of_live"
    if ancestor(candidate, live):
        return "skip-superseded", live, "candidate_older_than_live"
    return "refuse", live, "histories_diverged"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", required=True)
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--readback-url")
    ap.add_argument("--readback-path")
    ap.add_argument("--cloudflare-script")
    ap.add_argument("--preview", action="store_true", help="report the decision without failing (pre-merge evidence)")
    ap.add_argument("--verify-promoted", action="store_true", help="after promotion: the effective version must BE the candidate")
    args = ap.parse_args(argv)
    if args.verify_promoted:
        return verify_promoted(args)

    live_http = readback_sha(args.readback_url, args.readback_path)
    live_cf = cloudflare_sha(args.cloudflare_script)
    decision, live, reason = decide(args.candidate, live_http, live_cf, lambda a, b: is_ancestor(a, b, args.repo))
    record = {"service": args.service, "candidate": args.candidate, "live_cloudflare": live_cf,
              "live_readback": live_http, "decision": decision, "reason": reason, "preview": args.preview}
    print("PROMOTION_GUARD=" + json.dumps(record, sort_keys=True))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"decision={decision}\nlive_sha={live or ''}\nreason={reason}\n")
    level = "error" if decision == "refuse" and not args.preview else "notice"
    print(f"::{level} title=PROMOTION_GUARD_{args.service}::{decision} ({reason}) cloudflare={live_cf or 'unreadable'} readback={live_http or 'unreadable'}")
    return 1 if decision == "refuse" and not args.preview else 0


def verify_effective(candidate: str, live_http: str | None, live_cf: str | None) -> tuple[bool, str]:
    candidate = norm(candidate) or ""
    if not (live_http or live_cf):
        return False, "effective_version_unreadable_after_promotion"
    for label, value in (("cloudflare", live_cf), ("readback", live_http)):
        if value and value != candidate:
            return False, f"{label}_reports_{value[:12]}_not_{candidate[:12]}"
    return True, "effective_version_is_candidate"


def verify_promoted(args) -> int:
    import time
    ok, reason, live_http, live_cf = False, "", None, None
    for _ in range(18):  # up to ~3 minutes for edge propagation
        live_http = readback_sha(args.readback_url, args.readback_path)
        live_cf = cloudflare_sha(args.cloudflare_script)
        ok, reason = verify_effective(args.candidate, live_http, live_cf)
        if ok:
            break
        time.sleep(10)
    print("POST_PROMOTION=" + json.dumps({"service": args.service, "candidate": args.candidate, "cloudflare": live_cf, "readback": live_http, "ok": ok, "reason": reason}, sort_keys=True))
    print(f"::{'notice' if ok else 'error'} title=POST_PROMOTION_{args.service}::{reason}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
