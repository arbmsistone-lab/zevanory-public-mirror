#!/usr/bin/env bash
set -euo pipefail

echo "ZEVANORY_CLOUDFLARE_BUILD_SHA=${CLOUDFLARE_COMMIT_SHA:-${CI_COMMIT_SHA:-${GIT_COMMIT_SHA:-$(git rev-parse HEAD)}}}"

node scripts/support_knowledge_test.mjs
node scripts/whatsapp_conversation_test.mjs
node scripts/voice_remote_tts_test.mjs
node scripts/whatsapp_audio_runtime_test.mjs
node --test tests/sandbox_credential_isolation.test.mjs tests/sandbox_proof_v2.test.mjs

while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find worker -type f -name '*.mjs' -print0)

python3 scripts/deploy/prepare-central-candidate.py
