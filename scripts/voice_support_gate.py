#!/usr/bin/env python3
from pathlib import Path
p=Path("worker/cloudflare-worker.recovered.mjs")
s=p.read_text(encoding="utf-8")
required=[
  "function voiceReplyRequested",
  "function ttsBytesFromRuntime",
  "function stageVoiceTemporarily",
  "function uploadVoiceToWhatsapp",
  'generated_voice: generatedVoice',
  'reply_modality: replyModality',
  'inbound_media_type: inboundMediaType',
  'VOICE_TTS_FREE_ONLY',
  'ZEVANORY_VOICE_SUPPORT_ENABLED',
  'whatsapp_voice_upload_http_'
]
missing=[x for x in required if x not in s]
assert not missing, f"missing voice engine markers: {missing}"
assert 'support_only: true' in s
assert 'commercial_intent: false' in s
assert 'type: "audio", audio: { id: uploaded.media_id }' in s
assert 'ZEVANORY_VOICE_TEMP.delete' in s
assert 'generatedVoice = false' in s
assert 'inboundMediaType === "audio"' in s
print("VOICE_ENGINE_STATIC_GATE=PASS")

# Gemini pt-BR runtime certification
assert 'gemini-2.5-flash-preview-tts' in s
assert 'response_format: { type: "audio", mime_type: "audio/mp3"' in s
assert 'language: "pt-BR"' in s
assert 'voice_tts_model_not_zero_spend_certified' in s
assert 'VOICE_NATURALITY_CERTIFIED' in s
assert 'VOICE_WHATSAPP_E2E_CERTIFIED' in s
assert '/api/voice/status' in s
print("VOICE_GEMINI_PTBR_RUNTIME_GATE=PASS")

assert 'new Set(["groq", "openrouter", "gemini"])' in s
assert 'loadAiVaultSecret("gemini"' in s
assert 'provider_vault_supported: true' in s
print("VOICE_GEMINI_VAULT_GATE=PASS")

# ZERO_SPEND primary runtime: self-hosted Piper pt-BR relay
assert 'provider === "piper-relay"' in s
assert 'pt_BR-jeff-medium' in s
assert 'voice_tts_piper_relay_http_' in s
assert '/api/voice/probe' in s
assert 'provider_secretless_origin_auth' in s
print("VOICE_PIPER_PTBR_ZERO_SPEND_PRIMARY_GATE=PASS")


router=Path("worker/voice-provider-router.mjs").read_text(encoding="utf-8")
for marker in [
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
]:
    assert marker in router, f"missing provider router marker: {marker}"
assert 'ttsBytesWithFailover' in s
assert 'voiceProviderStatus' in s
print("VOICE_MULTI_PROVIDER_ZERO_SPEND_FAILOVER_GATE=PASS")
