#!/usr/bin/env bash
# Reserve build for Cloudflare Workers Builds. Reproduces the candidate
# reconstruction of .github/workflows/central-production-deploy.yml exactly and
# ends with a Wrangler dry-run, so the Workers Builds deploy command
#   npx wrangler deploy --strict --keep-vars --config wrangler.central-fix.jsonc
# only ever ships a candidate that passed every gate below. Fail-closed.
set -euo pipefail

SHA="${WORKERS_CI_COMMIT_SHA:-${CF_PAGES_COMMIT_SHA:-$(git rev-parse HEAD)}}"
export TARGET_RUNTIME_SHA="$SHA"
export PUBLIC_OWNER_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-arbmsistone-lab/zevanory-public-mirror}"
export GITHUB_SHA="$SHA"
echo "ZEVANORY_CLOUDFLARE_BUILD_SHA=$SHA"

# Workers Builds clones shallowly; the canonical static base needs full history.
git fetch --quiet --unshallow origin 2>/dev/null || true
git fetch --quiet origin final-83620c6 || git fetch --quiet origin 83620c680958d726fc4b0fd16e2574cdcc362a6d

# 1. Gates (same tests as the GitHub gates for the WhatsApp/voice/sandbox runtime)
node scripts/support_knowledge_test.mjs
node scripts/whatsapp_conversation_test.mjs
node scripts/voice_remote_tts_test.mjs
node scripts/whatsapp_audio_runtime_test.mjs
node --test tests/sandbox_credential_isolation.test.mjs tests/sandbox_proof_v2.test.mjs
while IFS= read -r -d '' file; do node --check "$file"; done < <(find worker -type f -name '*.mjs' -print0)

# 2. Candidate reconstruction (verbatim from central-production-deploy.yml)
rm -rf public
git archive 83620c680958d726fc4b0fd16e2574cdcc362a6d public | tar -x
node scripts/deploy/materialize-control-plane.mjs
cmp -s worker/live-recovered/control-plane-vnext.js public/control-plane-vnext.js
cp admin.css public/admin.css
python3 scripts/deploy/write-build-info.py
git show 83620c680958d726fc4b0fd16e2574cdcc362a6d:wrangler.jsonc > wrangler.central-fix.jsonc
python3 scripts/deploy/prepare-central-candidate.py
node --check worker/cloudflare-worker.compat.mjs
node --check public/control-plane-vnext.js

# 3. Never ship a candidate with sales open or test/production credentials mixed.
python3 - <<'PY'
import json
c = json.load(open("wrangler.central-fix.jsonc"))
v = c.get("vars", {})
assert v.get("SALE_GLOBALLY_ENABLED") == "false", "sales must stay blocked"
assert c.get("main") == "worker/cloudflare-worker.compat.mjs", "unexpected entry"
assert c.get("account_id") == "1b26415802588185a86c1d4d3ebf5bdb", "unexpected account"
print("RESERVE_CANDIDATE_GUARDS=PASS")
PY

# 4. T1 pre-promotion guard (registered reserve path, ops/publishers.json "workers_builds"). Workers Builds runs
#    the dashboard deploy command only after this build command succeeds, so the guard sits BEFORE the write.
#    Only "promote" (candidate is the live SHA or a descendant of it) lets the build pass: skip-superseded and
#    refuse both fail the build, so the deploy command never runs. CircleCI runs this script as a test job
#    without deploying (final step is a dry-run); there the guard is skipped explicitly and visibly.
if [ "${CIRCLECI:-}" = "true" ]; then
  echo "T1_RESERVE_GUARD=SKIPPED_CIRCLECI (test job, never deploys)"
else
  guard_out="$(mktemp)"
  GITHUB_OUTPUT="$guard_out" python3 scripts/deploy/promotion_guard.py --service zevanory --candidate "$SHA" \
    --readback-url https://zevanory.api.br/api/release --readback-path deployment.commit_sha \
    --cloudflare-script zevanory
  grep -qx "decision=promote" "$guard_out" || { echo "T1_RESERVE_GUARD=NOT_PROMOTE $(tr '\n' ' ' < "$guard_out")"; exit 1; }
  echo "T1_RESERVE_GUARD=PROMOTE"
fi

# 5. Final dry-run with the exact deploy flags.
npx --yes wrangler@4.143.0 deploy --dry-run --strict --keep-vars --config wrangler.central-fix.jsonc --outdir /tmp/central-final
echo "ZEVANORY_RESERVE_BUILD=PASS $SHA"
