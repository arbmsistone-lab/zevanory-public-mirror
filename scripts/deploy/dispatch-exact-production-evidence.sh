#!/usr/bin/env bash
set -euo pipefail
expected="${1:?target runtime sha}"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]]
repo="${GITHUB_REPOSITORY:?}"
head="$(gh api "repos/$repo/git/ref/heads/gh-pages" --jq '.object.sha')"
if [ "$head" != "$expected" ]; then
  echo "::warning title=EXACT_RELEASE_HEAD_MISMATCH::head=$head target=$expected; dispatch skipped"
  exit 0
fi
live="$(curl -fsS --retry 3 --max-time 25 https://zevanory.api.br/api/release | jq -r '.deployment.commit_sha // empty')"
if [ "$live" != "$expected" ]; then
  echo "::warning title=EXACT_RELEASE_NOT_LIVE::live=${live:-unavailable} target=$expected; dispatch skipped"
  exit 0
fi
for wf in zevanory-provider-independence.yml zevanory-portable-dr.yml zevanory-three-provider-quorum.yml; do
  head="$(gh api "repos/$repo/git/ref/heads/gh-pages" --jq '.object.sha')"
  if [ "$head" != "$expected" ]; then
    echo "::warning title=EXACT_RELEASE_HEAD_MOVED::workflow=$wf dispatch skipped"
    exit 0
  fi
  gh workflow run "$wf" --ref gh-pages
  echo "ZEES16_EVIDENCE_DISPATCHED=$wf TARGET_SHA=$expected"
done
# Completion of the three workflows also triggers the reconciler via workflow_run.
# Do not dispatch the reconciler before provider evidence has had a chance to finish.
echo "ZEES16_RECONCILER=TRIGGERED_BY_WORKFLOW_RUN_AFTER_EVIDENCE"
