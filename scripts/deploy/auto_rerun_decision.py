#!/usr/bin/env python3
"""Fail-closed replay decision for the production publisher (plan 3.1, T1; run 38461830758).

A failed "ZEVANORY central production deploy" run may be replayed automatically ONLY with positive
proof that the Worker was never published in that run:
  A) the guard job FAILED and the deploy job was SKIPPED (never started), or
  B) the deploy job FAILED with an earlier step FAILED, and both the publish step
     ("Deploy repaired production worker") and the rollback step are present and SKIPPED.
Anything else is NOT PROVEN and is never replayed: publish started/succeeded/cancelled, any rollback,
missing or unknown steps, incomplete job listing, API errors, a run that is not a completed,
failed first attempt. The decision is computed twice (the second time immediately before the
replay request) and must be identical. A replay is a FULL rerun, so the guard re-reads production.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

PUBLISH = "Deploy repaired production worker"
ROLLBACK_PREFIX = "Automatic rollback"


def api_get(url: str, token: str):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 (fixed GitHub API)
        return json.loads(r.read().decode())


def decide(run: dict | None, jobs: dict | None) -> tuple[str, str]:
    """Returns ("pre_publish", why) or ("refuse", why)."""
    if not isinstance(run, dict) or not isinstance(jobs, dict):
        return "refuse", "not_proven:api_response_missing"
    if run.get("status") != "completed" or run.get("conclusion") != "failure" or run.get("run_attempt") != 1:
        return "refuse", f"not_proven:run_state:{run.get('status')}/{run.get('conclusion')}/attempt={run.get('run_attempt')}"
    listed = jobs.get("jobs")
    if not isinstance(listed, list) or not listed or jobs.get("total_count") != len(listed):
        return "refuse", "not_proven:incomplete_job_listing"
    by_name = {j.get("name"): j for j in listed}
    if set(by_name) != {"guard", "deploy"}:
        return "refuse", f"not_proven:unexpected_jobs:{sorted(map(str, by_name))}"
    guard, deploy = by_name["guard"], by_name["deploy"]
    if guard.get("status") != "completed" or deploy.get("status") != "completed":
        return "refuse", "not_proven:job_not_completed"
    if guard.get("conclusion") == "failure" and deploy.get("conclusion") == "skipped":
        return "pre_publish", "guard_failed_deploy_never_started"
    if guard.get("conclusion") != "success" or deploy.get("conclusion") != "failure":
        return "refuse", f"not_proven:job_conclusions:{guard.get('conclusion')}/{deploy.get('conclusion')}"
    steps = deploy.get("steps")
    if not isinstance(steps, list) or not steps:
        return "refuse", "not_proven:steps_missing"
    names = [s.get("name") for s in steps]
    if names.count(PUBLISH) != 1:
        return "refuse", "not_proven:publish_step_missing_or_ambiguous"
    rollbacks = [s for s in steps if str(s.get("name", "")).startswith(ROLLBACK_PREFIX)]
    if len(rollbacks) != 1:
        return "refuse", "not_proven:rollback_step_missing_or_ambiguous"
    i_pub = names.index(PUBLISH)
    publish = steps[i_pub]
    if publish.get("conclusion") != "skipped" or rollbacks[0].get("conclusion") != "skipped":
        return "refuse", f"publish_or_rollback_ran:{publish.get('conclusion')}/{rollbacks[0].get('conclusion')}"
    before = steps[:i_pub]
    if not any(s.get("conclusion") == "failure" for s in before):
        return "refuse", "not_proven:no_failure_before_publish"
    if any(s.get("conclusion") not in ("success", "failure", "skipped") for s in before):
        return "refuse", "not_proven:unknown_step_state_before_publish"
    return "pre_publish", "failed_before_publish_step"


def evaluate(fetch, base: str) -> tuple[str, str, dict | None]:
    try:
        run = fetch(base)
        jobs = fetch(base + "/jobs?per_page=100")
    except Exception as e:  # API unavailable, HTTP error, bad JSON
        return "refuse", f"not_proven:api_error:{type(e).__name__}", None
    verdict, why = decide(run, jobs)
    return verdict, why, run


def main(fetch=None, sleep=time.sleep, out=print) -> int:
    repo, run_id, token = os.environ["GITHUB_REPOSITORY"], os.environ["RUN_ID"], os.environ["GH_TOKEN"]
    base = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}"
    fetch = fetch or (lambda url: api_get(url, token))
    verdict, why, run = evaluate(fetch, base)
    if verdict != "pre_publish":
        out(f"::warning title=AUTO_RERUN_REFUSED::central deploy run {run_id}: {why}; owner decision required, no automatic replay")
        out(f"DECISION=refuse:{why}")
        return 0
    sleep(90)
    # Revalidate immediately before the replay: same verdict, same commit, still the first attempt.
    verdict2, why2, run2 = evaluate(fetch, base)
    if verdict2 != "pre_publish" or (run2 or {}).get("head_sha") != (run or {}).get("head_sha"):
        out(f"::warning title=AUTO_RERUN_REFUSED::central deploy run {run_id}: revalidation failed ({why2}); no automatic replay")
        out(f"DECISION=refuse:revalidation:{why2}")
        return 0
    out(f"DECISION=replay:{why2}")
    return 10  # caller performs the FULL rerun (POST .../rerun)


if __name__ == "__main__":
    sys.exit(main())
