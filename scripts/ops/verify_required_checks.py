#!/usr/bin/env python3
"""ZEVANORY | Post-merge bootstrap verification of the protected legal check (Sol ORDEM 312, item 4). READ-ONLY.

The pull_request_target check legal-trust-anchors-protected only protects PRs opened AFTER its definition is on
gh-pages; it never protects the PR that introduces it. After merging PR #946 the owner must:
  1. confirm the workflow exists on gh-pages;
  2. make `protected-trust-anchors` a required status check of gh-pages;
  3. allow squash merges only (no rebase merge, no merge commit).
This script confirms the three through the GitHub REST API (GET only, via `gh api`), or from saved JSON (--fixtures,
tests). It never changes a setting.

Usage: verify_required_checks.py [--repo owner/name] [--branch gh-pages]
       verify_required_checks.py --fixtures <dir with branch.json, repo.json, rules.json, workflow.json>
Output: PROTECTED_CHECK_WORKFLOW=..., REQUIRED_CHECK=..., SQUASH_ONLY=..., BOOTSTRAP=COMPLETE|INCOMPLETE (rc 0|1).
"""
from __future__ import annotations

import argparse, json, subprocess, sys
from pathlib import Path

CHECK = "protected-trust-anchors"
WORKFLOW = ".github/workflows/legal-trust-anchors-protected.yml"


def _is_check(ctx: str) -> bool:
    ctx = str(ctx or "").strip()
    return ctx == CHECK or ctx.endswith("/ " + CHECK)


def evaluate(branch: dict | None, repo: dict | None, rules: list | None, workflow: dict | None) -> tuple[bool, list[str]]:
    lines = []
    wf_ok = isinstance(workflow, dict) and workflow.get("path") == WORKFLOW
    lines.append(f"PROTECTED_CHECK_WORKFLOW={'PRESENT' if wf_ok else 'ABSENT'} ({WORKFLOW} on the branch)")
    contexts = []
    rsc = ((branch or {}).get("protection") or {}).get("required_status_checks") or {}
    contexts += list(rsc.get("contexts") or []) + [c.get("context") for c in rsc.get("checks") or [] if isinstance(c, dict)]
    for rule in rules or []:
        if isinstance(rule, dict) and rule.get("type") == "required_status_checks":
            contexts += [c.get("context") for c in (rule.get("parameters") or {}).get("required_status_checks") or [] if isinstance(c, dict)]
    req_ok = any(_is_check(c) for c in contexts)
    lines.append(f"REQUIRED_CHECK={'PRESENT' if req_ok else 'ABSENT'} ({CHECK}; required now: {sorted(set(c for c in contexts if c))})")
    r = repo or {}
    squash_ok = r.get("allow_squash_merge") is True and r.get("allow_rebase_merge") is False and r.get("allow_merge_commit") is False
    lines.append(f"SQUASH_ONLY={'YES' if squash_ok else 'NO'} (squash={r.get('allow_squash_merge')} rebase={r.get('allow_rebase_merge')} merge_commit={r.get('allow_merge_commit')})")
    ok = wf_ok and req_ok and squash_ok
    lines.append(f"BOOTSTRAP={'COMPLETE' if ok else 'INCOMPLETE'}")
    return ok, lines


def _gh(path: str):
    p = subprocess.run(["gh", "api", "-X", "GET", path], capture_output=True, text=True)
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except ValueError:
        return None


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="arbmsistone-lab/zevanory-public-mirror")
    ap.add_argument("--branch", default="gh-pages")
    ap.add_argument("--fixtures")
    a = ap.parse_args(argv)
    if a.fixtures:
        def load(n):
            f = Path(a.fixtures, n)
            return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
        branch, repo, rules, workflow = load("branch.json"), load("repo.json"), load("rules.json"), load("workflow.json")
    else:
        branch = _gh(f"repos/{a.repo}/branches/{a.branch}")
        repo = _gh(f"repos/{a.repo}")
        rules = _gh(f"repos/{a.repo}/rules/branches/{a.branch}")
        workflow = _gh(f"repos/{a.repo}/contents/{WORKFLOW}?ref={a.branch}")
    ok, lines = evaluate(branch, repo, rules, workflow)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
