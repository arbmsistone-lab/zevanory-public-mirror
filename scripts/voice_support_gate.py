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
assert 'c["vars"]["VOICE_TTS_FREE_ONLY"]' not in deploy
assert 'c["vars"]["ZEVANORY_VOICE_SUPPORT_ENABLED"]' not in deploy
print("VOICE_PRODUCTION_FAIL_CLOSED_ZERO_SPEND_CONFIG_GATE=PASS")

assert 'VOICE_NATURALITY_CERTIFIED' in worker
assert 'VOICE_WHATSAPP_E2E_CERTIFIED' in worker
assert 'naturality_certified:' in worker
assert 'e2e_official_number_certified:' in worker
print("VOICE_CERTIFICATION_FAIL_CLOSED_GATE=PASS")


study=Path("worker/voice-naturality-study.mjs").read_text(encoding="utf-8")
compat=Path("worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
for marker in [
  'unique_evaluators>=100',
  'natural_acceptance>=99',
  'intelligibility>=99',
  'mean_naturalness>=4.8',
  'human_attested===true',
  'duplicate_evaluator',
  'clip_assignment_mismatch',
  'provider_disclosed:false',
  'x-voice-study-blinded',
  'voice-study/rating/',
  'voice-study/fingerprint/',
]:
    assert marker in study, f"missing human study marker: {marker}"
assert 'handleVoiceStudy' in compat
assert 'url.pathname === "/voice-study"' in compat
assert 'url.pathname.startsWith("/api/voice-study/")' in compat
print("VOICE_HUMAN_BLIND_CERTIFICATION_PORTAL_GATE=PASS")


whatsapp=Path("worker/whatsapp-onboarding.mjs").read_text(encoding="utf-8")
compat=Path("worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
for marker in [
  'OFFICIAL_E164 = "5588992545413"',
  'whatsapp_business_management',
  'whatsapp_business_messaging',
  '/owned_whatsapp_business_accounts',
  '/phone_numbers?fields=',
  '/subscribed_apps',
  '/register',
  'callback_url',
  'x-hub-signature-256',
  'AES-GCM',
  'whatsapp-onboarding/runtime',
  'identity_verified',
]:
    assert marker in whatsapp or marker in worker, f"missing WhatsApp onboarding marker: {marker}"
assert 'loadWhatsappRuntimeCredentials' in compat
assert '__ZEVANORY_WHATSAPP_RUNTIME__' in compat
assert '__ZEVANORY_WHATSAPP_RUNTIME__' in worker
assert 'META_APP_SECRET || whatsappRuntime.app_secret' in worker
assert 'WHATSAPP_ACCESS_TOKEN || whatsappRuntime.access_token' in worker
assert 'WHATSAPP_PHONE_NUMBER_ID || whatsappRuntime.phone_number_id' in worker
print("WHATSAPP_SECURE_ONBOARDING_RUNTIME_GATE=PASS")


e2e=Path("worker/whatsapp-e2e-evidence.mjs").read_text(encoding="utf-8")
closure=Path("worker/voice-final-closure.mjs").read_text(encoding="utf-8")
compat=Path("worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
for marker in [
  'inbound_processed',
  'outbound_voice',
  'delivery',
  'contact_hash',
  'provider_message_id',
  'whatsapp-e2e/',
  'e2e:Boolean(chain)',
]:
    assert marker in e2e, f"missing WhatsApp E2E evidence marker: {marker}"
for marker in [
  'voice_naturality_certified',
  'whatsapp_transport_configured',
  'whatsapp_e2e',
  'canonical_sha_consistent',
  'regression_gates',
  'final_green',
  'voice-final/certification',
]:
    assert marker in closure, f"missing final closure marker: {marker}"
assert '__ZEVANORY_WHATSAPP_E2E_STORE__' in compat
assert 'recordWhatsappEvidence("inbound_processed"' in worker
assert 'recordWhatsappEvidence("outbound_voice"' in worker
assert 'recordWhatsappEvidence("delivery"' in worker
print("WHATSAPP_E2E_AUDIT_LEDGER_GATE=PASS")
print("VOICE_CANONICAL_FINAL_CLOSURE_GATE=PASS")


human_reconcile=Path(".github/workflows/voice-human-certification-reconcile.yml").read_text(encoding="utf-8")
final_reconcile=Path(".github/workflows/voice-final-closure-reconcile.yml").read_text(encoding="utf-8")
assert 'release_sha:sha' in study
assert 'voice-study/rating/${sha}/' in study
assert 'voice-study/fingerprint/${sha}/' in study
assert 'release_sha,' in e2e
assert 'whatsapp-e2e/${release_sha}/' in e2e
assert '__ZEVANORY_RELEASE_SHA__' in compat
assert 'perceptual_evidence_same_sha' in closure
assert 'whatsapp_e2e_same_sha' in closure
assert 'No code, evidence file, policy, score or gate is mutated.' in human_reconcile
assert 'gh pr create' not in human_reconcile
assert "REGRESSION_GATES=PASS" in final_reconcile
assert "PERCEPTUAL_EVIDENCE_SAME_SHA" in final_reconcile
assert "WHATSAPP_E2E_SAME_SHA" in final_reconcile
print("VOICE_CANONICAL_EVIDENCE_SHA_BINDING_GATE=PASS")
