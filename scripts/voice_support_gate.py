#!/usr/bin/env python3
from pathlib import Path

worker=Path("worker/cloudflare-worker.recovered.mjs").read_text(encoding="utf-8")
router=Path("worker/voice-provider-router.mjs").read_text(encoding="utf-8")
deploy=Path(".github/workflows/central-production-deploy.yml").read_text(encoding="utf-8")

worker_required=[
  "function voiceReplyRequested",
  "function ttsBytesFromRuntime",
  "function stageVoiceTemporarily",
  "function uploadVoiceToWhatsapp",
  'generated_voice: generatedVoice',
  'reply_modality: replyModality',
  'inbound_media_type: inboundMediaType',
  'ZEVANORY_VOICE_SUPPORT_ENABLED',
  'whatsapp_voice_upload_http_',
  'loadAiVaultSecret("gemini"',
  'provider_vault_supported: true',
  '/api/voice/status',
  '/api/voice/probe',
  'ttsBytesWithFailover',
  'voiceProviderStatus',
]
missing=[x for x in worker_required if x not in worker]
assert not missing, f"missing voice engine markers: {missing}"
assert 'support_only: true' in worker
assert 'commercial_intent: false' in worker
assert 'type: "audio", audio: { id: uploaded.media_id }' in worker
assert 'ZEVANORY_VOICE_TEMP.delete' in worker
assert 'generatedVoice = false' in worker
assert 'inboundMediaType === "audio"' in worker
print("VOICE_ENGINE_STATIC_GATE=PASS")

router_required=[
  'DEFAULT_CHAIN = Object.freeze(["speechify", "azure", "piper-relay", "gemini"])',
  'VOICE_TTS_FAILOVER_ENABLED',
  'VOICE_TTS_FREE_ONLY',
  'SPEECHIFY_FREE_TIER_CONFIRMED',
  'AZURE_SPEECH_FREE_TIER_CONFIRMED',
  'GEMINI_FREE_TIER_CONFIRMED',
  'FAILURE_THRESHOLD = 2',
  'COOLDOWN_MS = 5 * 60 * 1000',
  'voice_tts_all_providers_failed',
  'pt-BR-FranciscaNeural',
  'simba-3.0',
  'pt_BR-jeff-medium',
  'gemini-3.1-flash-tts-preview',
  'voice_tts_speechify_http_',
  'voice_tts_azure_http_',
  'voice_tts_piper_relay_http_',
  'voice_tts_gemini_http_',
  'language: "pt-BR"',
  'response_format: { type: "audio", mime_type: "audio/mp3"',
]
missing=[x for x in router_required if x not in router]
assert not missing, f"missing provider router markers: {missing}"
print("VOICE_MULTI_PROVIDER_ZERO_SPEND_FAILOVER_GATE=PASS")

for marker in [
  'c["vars"]["VOICE_TTS_PROVIDER_CHAIN"]="speechify,azure,piper-relay,gemini"',
  'c["vars"]["VOICE_TTS_FAILOVER_ENABLED"]="true"',
  'c["vars"]["SPEECHIFY_FREE_TIER_CONFIRMED"]="false"',
  'c["vars"]["AZURE_SPEECH_FREE_TIER_CONFIRMED"]="false"',
  'c["vars"]["GEMINI_FREE_TIER_CONFIRMED"]="false"',
  'c["vars"]["VOICE_TTS_RELAY_URL"]="https://tts.167-172-146-60.sslip.io"',
]:
    assert marker in deploy, f"missing production voice var: {marker}"

# These two controls are Cloudflare secret_text bindings in production. They must
# be preserved remotely rather than redeclared as plain vars, otherwise Wrangler
# --strict correctly aborts the deployment because the binding type would change.
assert 'VOICE_TTS_FREE_ONLY and ZEVANORY_VOICE_SUPPORT_ENABLED are stored as remote secrets.' in deploy
assert 'c["vars"]["VOICE_TTS_FREE_ONLY"]="true"' not in deploy
assert 'c["vars"]["ZEVANORY_VOICE_SUPPORT_ENABLED"]="true"' not in deploy
print("VOICE_PRODUCTION_SECRET_PRESERVATION_GATE=PASS")
print("VOICE_PRODUCTION_FAIL_CLOSED_ZERO_SPEND_CONFIG_GATE=PASS")

assert 'VOICE_NATURALITY_CERTIFIED' in worker
assert 'VOICE_WHATSAPP_E2E_CERTIFIED' in worker
assert 'naturality_certified:' in worker
assert 'e2e_official_number_certified:' in worker
print("VOICE_CERTIFICATION_FAIL_CLOSED_GATE=PASS")
