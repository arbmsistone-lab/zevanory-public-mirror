#!/usr/bin/env bash
# Confirms the canonical domain serves the exact SHA after a reserve deploy.
# Usage: bash scripts/ci/cloudflare-post-deploy-verify.sh <expected_sha>
# On mismatch after ~3 minutes: exit 1 and print the rollback command to run.
set -euo pipefail
EXPECTED="${1:?expected sha required}"
for i in $(seq 1 18); do
  LIVE="$(curl -fsS -H 'cache-control: no-cache' "https://zevanory.api.br/api/release?t=$(date +%s)" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("deployment",{}).get("commit_sha",""))' || true)"
  if [ "$LIVE" = "$EXPECTED" ]; then echo "RESERVE_RELEASE_VERIFIED=$LIVE"; exit 0; fi
  sleep 10
done
echo "RESERVE_RELEASE_MISMATCH expected=$EXPECTED live=${LIVE:-none}"
echo "ROLLBACK: npx wrangler rollback --name zevanory --config wrangler.central-fix.jsonc --message reserve-verify-failed"
exit 1
