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
# Wait for all three dispatches on this exact commit before reconciling.
workflows=(zevanory-provider-independence.yml zevanory-portable-dr.yml zevanory-three-provider-quorum.yml)
for attempt in $(seq 1 90); do
  completed=0
  for wf in "${workflows[@]}"; do
    result="$(gh run list --workflow "$wf" --branch gh-pages --event workflow_dispatch --limit 10 --json headSha,status,conclusion --jq '[.[] | select(.headSha == "'$expected'")][0] | if . == null then "missing" elif .status != "completed" then "running" else .conclusion end')"
    if [ "$result" = "failure" ] || [ "$result" = "cancelled" ]; then
      echo "::error title=ZEES16_EVIDENCE_NOT_GREEN::$wf $result"
      exit 1
    fi
    [ "$result" = "success" ] && completed=$((completed+1))
  done
  [ "$completed" = 3 ] && break
  sleep 8
done
if [ "$completed" != 3 ]; then
  echo "::error title=ZEES16_EVIDENCE_TIMEOUT::Only $completed/3 workflows succeeded"
  exit 1
fi
head="$(gh api "repos/$repo/git/ref/heads/gh-pages" --jq '.object.sha')"
live="$(curl -fsS --max-time 25 https://zevanory.api.br/api/release | jq -r '.deployment.commit_sha // empty')"
if [ "$head" != "$expected" ] || [ "$live" != "$expected" ]; then
  echo "::warning title=ZEES16_RECONCILER_SHA_MOVED::head=$head live=$live target=$expected"
  exit 0
fi
gh workflow run zees16-control-reconciler.yml --ref gh-pages
echo "ZEES16_RECONCILER_DISPATCHED_SHA=$expected"
