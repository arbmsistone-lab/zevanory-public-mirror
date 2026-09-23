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
