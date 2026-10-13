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


# Observation of one source after a promotion:
#   ("ok", sha)          the source answered with a valid SHA
#   ("answered", None)   the source ANSWERED but without a valid SHA: positive evidence that the
#                        effective state is not a tagged candidate (HTTP error status from the
#                        service, JSON without the SHA, Cloudflare with no single 100% tagged version)
#   ("unreachable", None) the observer could not reach the source (network, timeout, missing
#                        credential, Cloudflare API error): NO evidence either way
OK, ANSWERED, UNREACHABLE = "ok", "answered", "unreachable"


def observe_readback(url: str | None, path: str | None, fetch=_get) -> tuple[str, str | None]:
    import urllib.error
    if not url or not path:
        return UNREACHABLE, None
    try:
        body = fetch(url)
    except urllib.error.HTTPError:
        return ANSWERED, None  # the production service itself answered with an error status
    except Exception:
        return UNREACHABLE, None  # network/timeout/TLS: the observer failed, not the service
    sha = norm(_dig(body, path))
    return (OK, sha) if sha else (ANSWERED, None)


def readback_sha(url: str | None, path: str | None, fetch=_get) -> str | None:
    return observe_readback(url, path, fetch)[1]


def cloudflare_sha(script: str | None, fetch=_get) -> str | None:
    """SHA tagged on the version that currently serves 100% of the script's traffic."""
    return observe_cloudflare(script, fetch)[1]


def observe_cloudflare(script: str | None, fetch=_get) -> tuple[str, str | None]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not script or not token or not account:
        return UNREACHABLE, None
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{script}"
    auth = {"Authorization": f"Bearer {token}"}
    try:
        listing = fetch(base + "/deployments", auth)
        if listing.get("success") is False:
            return UNREACHABLE, None
        deployments = (listing.get("result") or {}).get("deployments") or []
        if not deployments:
            return ANSWERED, None
        versions = deployments[0].get("versions") or []
        full = [v for v in versions if int(v.get("percentage") or 0) == 100]
        if len(full) != 1:
            return ANSWERED, None  # gradual rollout: not a single effective version
        detail = fetch(f"{base}/versions/{full[0].get('version_id')}", auth)
        if detail.get("success") is False:
            return UNREACHABLE, None
        version = detail.get("result") or {}
        annotations = (version.get("metadata") or {}).get("annotations") or version.get("annotations") or {}
        sha = norm(annotations.get("workers/tag"))
        return (OK, sha) if sha else (ANSWERED, None)  # active version without our tag
    except Exception:
        return UNREACHABLE, None  # API/network/credential failure: the observer failed


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
    ap.add_argument("--unproven-exit", type=int, default=2, help="exit code for NAO_COMPROVADO (0 = defer to a later certification gate)")
    ap.add_argument("--attempts", type=int, default=18)
    ap.add_argument("--interval", type=float, default=10.0)
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


def _as_obs(value) -> tuple[str, str | None]:
    if isinstance(value, tuple):
        return value
    sha = norm(value)
    return (OK, sha) if sha else (UNREACHABLE, None)


def verify_effective(candidate: str, live_http, live_cf) -> tuple[bool, str]:
    """Post-promotion certification. BOTH sources are mandatory for PASS.

    Each source is an observation (status, sha) or a plain SHA/None (None = unreachable).
      PASS            both sources answered with the candidate.
      FAIL            positive evidence of a wrong effective state: a source reports another SHA,
                      the sources disagree, or a source answered without a valid SHA.
      NAO_COMPROVADO  no contrary evidence, but at least one source was unreachable. This is an
                      observability gap, NOT a failed release: it must not trigger rollback.
    """
    candidate = norm(candidate) or ""
    (s_http, live_http), (s_cf, live_cf) = _as_obs(live_http), _as_obs(live_cf)
    if live_http and live_cf and live_http != live_cf:
        return False, f"FAIL:sources_disagree_cloudflare_{live_cf[:12]}_readback_{live_http[:12]}"
    for label, value in (("cloudflare", live_cf), ("readback", live_http)):
        if value and value != candidate:
            return False, f"FAIL:{label}_reports_{value[:12]}_not_{candidate[:12]}"
    for label, status in (("cloudflare", s_cf), ("readback", s_http)):
        if status == ANSWERED:
            return False, f"FAIL:{label}_answered_without_candidate_sha"
    missing = [label for label, status in (("cloudflare", s_cf), ("readback", s_http)) if status != OK]
    if missing:
        return False, "NAO_COMPROVADO:" + "_and_".join(missing) + "_source_unreachable"
    return True, "PASS:effective_version_is_candidate"


def verify_promoted(args) -> int:
    import time
    ok, reason, obs_http, obs_cf = False, "", (UNREACHABLE, None), (UNREACHABLE, None)
    for _ in range(args.attempts):  # default ~3 minutes for edge propagation
        obs_http = observe_readback(args.readback_url, args.readback_path)
        obs_cf = observe_cloudflare(args.cloudflare_script)
        ok, reason = verify_effective(args.candidate, obs_http, obs_cf)
        if ok:
            break
        time.sleep(args.interval)
    state = reason.split(":", 1)[0]
    print("POST_PROMOTION=" + json.dumps({"service": args.service, "candidate": args.candidate,
          "cloudflare": obs_cf[1], "cloudflare_status": obs_cf[0], "readback": obs_http[1],
          "readback_status": obs_http[0], "ok": ok, "state": state, "reason": reason}, sort_keys=True))
    level = "notice" if ok else ("warning" if state == "NAO_COMPROVADO" else "error")
    print(f"::{level} title=POST_PROMOTION_{args.service}::{reason}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"state={state}\nreason={reason}\n")
    if ok:
        return 0
    # FAIL (positive evidence) always fails the step, so the workflow's recovery runs.
    # NAO_COMPROVADO uses --unproven-exit: workflows with automatic rollback pass 0 and fail the run
    # in a later certification gate, AFTER the rollback step, so an observability gap never rolls back.
    return args.unproven_exit if state == "NAO_COMPROVADO" else 1


if __name__ == "__main__":
    sys.exit(main())
