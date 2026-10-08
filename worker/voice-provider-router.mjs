import { encodePcmInChunks } from "./voice-chunks.mjs";
import { Buffer } from "node:buffer";
import lamejs from "./vendor/lame.min.mjs";
import { unpackPcm, encodePcmRemotely, downsamplePcmMono } from "./voice-pcm.mjs";
const DEFAULT_CHAIN = Object.freeze(["gemini"]);
// Owner rule: every ARBM One system is 100% free. Under VOICE_TTS_FREE_ONLY only providers
// that cannot bill are allowed: Gemini (no billing account linked => free tier only) and
// Azure Speech only when explicitly confirmed on the F0 free tier. Speechify (paid API) and
// the piper relay (paid VPS) are never allowed in zero-spend mode.
const ZERO_SPEND_PROVIDERS = Object.freeze(["gemini", "azure"]);
function zeroSpendAllowed(provider, env = {}) {
  if (!ZERO_SPEND_PROVIDERS.includes(provider)) return false;
  if (provider === "azure") return String(env.AZURE_SPEECH_FREE_TIER_CONFIRMED || "").toLowerCase() === "true";
  return true;
}
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 5 * 60 * 1000;
const breaker = globalThis.__ZEVANORY_VOICE_BREAKER__ || new Map();
globalThis.__ZEVANORY_VOICE_BREAKER__ = breaker;

function cleanText(value, max = 1800) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function chainFromEnv(env = {}) {
  const configured = String(env.VOICE_TTS_PROVIDER_CHAIN || "").trim();
  const values = (configured ? configured.split(",") : DEFAULT_CHAIN)
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (String(env.VOICE_TTS_FREE_ONLY || "").toLowerCase() === "true") return unique.filter((p) => zeroSpendAllowed(p, env));
  return unique;
}

function isConfigured(provider, env = {}) {
  if (provider === "piper-relay") {
    return /^https:\/\//i.test(String(env.VOICE_TTS_RELAY_URL || ""));
  }
  if (provider === "speechify") {
    return Boolean(String(env.SPEECHIFY_API_KEY || "").trim())
      && Boolean(String(env.SPEECHIFY_VOICE_ID || "").trim())
      && String(env.SPEECHIFY_FREE_TIER_CONFIRMED || "").toLowerCase() === "true";
  }
  if (provider === "azure") {
    return Boolean(String(env.AZURE_SPEECH_KEY || "").trim())
      && Boolean(String(env.AZURE_SPEECH_REGION || "").trim())
      && String(env.AZURE_SPEECH_FREE_TIER_CONFIRMED || "").toLowerCase() === "true";
  }
  if (provider === "gemini") {
    return Boolean(String(env.GEMINI_API_KEY || "").trim())
      && String(env.GEMINI_FREE_TIER_CONFIRMED || "").toLowerCase() === "true";
  }
  return false;
}

function breakerState(provider) {
  const state = breaker.get(provider) || { failures: 0, openUntil: 0, lastError: null, lastSuccessAt: 0 };
  if (state.openUntil && Date.now() >= state.openUntil) {
    const reset = { failures: 0, openUntil: 0, lastError: state.lastError, lastSuccessAt: state.lastSuccessAt };
    breaker.set(provider, reset);
    return reset;
  }
  return state;
}

function providerAvailable(provider, env = {}) {
  const state = breakerState(provider);
  return isConfigured(provider, env) && (!state.openUntil || state.openUntil <= Date.now());
}

function noteSuccess(provider) {
  breaker.set(provider, { failures: 0, openUntil: 0, lastError: null, lastSuccessAt: Date.now() });
}

function noteFailure(provider, error) {
  const previous = breakerState(provider);
  const failures = Number(previous.failures || 0) + 1;
  breaker.set(provider, {
    failures,
    openUntil: failures >= FAILURE_THRESHOLD ? Date.now() + COOLDOWN_MS : 0,
    lastError: String(error?.message || error || "provider_failed").slice(0, 240),
    lastSuccessAt: Number(previous.lastSuccessAt || 0)
  });
}

function decodeBase64(value) {
  return new Uint8Array(Buffer.from(String(value || ""), "base64"));
}

function audioFormat(mimeValue) {
  const mime=String(mimeValue||"").split(";")[0].toLowerCase();
  return mime === "audio/mpeg" ? "mp3" : mime === "audio/ogg" ? "ogg" : mime === "audio/mp4" ? "m4a" : mime.split("/")[1] || "unknown";
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function speechifyTts(text, env, fetchImpl) {
  const key = String(env.SPEECHIFY_API_KEY || "").trim();
  const voice = String(env.SPEECHIFY_VOICE_ID || "").trim();
  const model = String(env.SPEECHIFY_MODEL || "simba-3.0").trim();
  const response = await fetchImpl("https://api.speechify.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      input: text,
      voice_id: voice,
      audio_format: "mp3",
      model,
      language: "pt-BR"
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`voice_tts_speechify_http_${response.status}`);
  const encoded = body?.audio_data;
  if (!encoded) throw new Error("voice_tts_speechify_audio_missing");
  const bytes = decodeBase64(encoded);
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("voice_tts_output_size_invalid");
  return Object.freeze({
    bytes,
    mime: "audio/mpeg",
    model,
    provider: "speechify",
    voice,
    language: "pt-BR",
    chars: text.length
  });
}

async function azureTts(text, env, fetchImpl) {
  const key = String(env.AZURE_SPEECH_KEY || "").trim();
  const region = String(env.AZURE_SPEECH_REGION || "").trim().toLowerCase();
  const voice = String(env.AZURE_SPEECH_VOICE || "pt-BR-FranciscaNeural").trim();
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = `<speak version="1.0" xml:lang="pt-BR"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "ZEVANORY-Voice-Support"
    },
    body: ssml,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`voice_tts_azure_http_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("voice_tts_output_size_invalid");
  return Object.freeze({
    bytes,
    mime: "audio/mpeg",
    model: "azure-neural-tts",
    provider: "azure",
    voice,
    language: "pt-BR",
    chars: text.length
  });
}

async function piperTts(text, env, fetchImpl) {
  const relay = String(env.VOICE_TTS_RELAY_URL || "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(relay)) throw new Error("voice_tts_relay_not_configured");
  const response = await fetchImpl(`${relay}/tts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Worker": "girolocal-rb.workers.dev"
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`voice_tts_piper_relay_http_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("voice_tts_output_size_invalid");
  return Object.freeze({
    bytes,
    mime: String(response.headers.get("content-type") || "audio/wav").split(";")[0],
    model: String(env.VOICE_TTS_PIPER_MODEL || env.VOICE_TTS_MODEL || "pt_BR-jeff-medium"),
    provider: "piper-relay",
    voice: String(env.VOICE_TTS_PIPER_VOICE || env.VOICE_TTS_VOICE || "jeff"),
    language: "pt-BR",
    chars: text.length
  });
}

// Gemini speech generation returns raw 16-bit PCM (24 kHz mono). WhatsApp only
// accepts compressed audio, so the PCM is encoded to MP3 inside the Worker.
export function pcm16ToMp3(pcmBytes, sampleRate = 24000, kbps = 64) {
  const samples = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, Math.floor(pcmBytes.byteLength / 2));
  const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
  const chunks = [];
  for (let i = 0; i < samples.length; i += 1152) {
    const out = encoder.encodeBuffer(samples.subarray(i, i + 1152));
    if (out.length) chunks.push(out);
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const mp3 = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { mp3.set(new Uint8Array(c.buffer, c.byteOffset, c.length), offset); offset += c.length; }
  return mp3;
}

function geminiTtsModels(env = {}) {
  const list = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]
    .map((m) => String(m || "").trim()).filter(Boolean);
  return [...new Set(list)];
}

async function geminiTts(text, env, fetchImpl, { onStage = async () => {} } = {}) {
  const key = String(env.GEMINI_API_KEY || "").trim();
  const voice = String(env.GEMINI_TTS_VOICE || "Achird").trim();
  const style = String(env.VOICE_TTS_STYLE || "Fale em português do Brasil, com voz natural, acolhedora, clara e profissional, em ritmo de conversa.").trim();
  const errors = [];
  const started = Date.now();
  const deadline = started + 30000;
  for (const model of geminiTtsModels(env)) {
    const modern = model.startsWith("gemini-3.8-");
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let response;
    try { response = await fetchImpl(modern ? "https://generativelanguage.googleapis.com/v1beta/interactions" : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(modern ? {
        model,
        input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
        response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 8000 },
        generation_config: { speech_config: [{ voice }] }
      } : {
        contents: [{ parts: [{ text: `${style}\n\n${text}` }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
      }),
      signal: AbortSignal.timeout(Math.min(15000, remaining))
    }); } catch (error) { errors.push(`${model}:${error?.name || "fetch_failed"}`); continue; }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { errors.push(`${model}:${response.status}`); if ([400,404,408,429,500,502,503,504].includes(response.status)) continue; break; }
    const part = modern
      ? (body.steps || []).filter(s => s.type === "model_output").flatMap(s => s.content || []).find(p => p.type === "audio" && p.data)
      : (body?.candidates?.[0]?.content?.parts || []).find((p) => p?.inlineData?.data || p?.inline_data?.data);
    const data = part?.data || part?.inlineData?.data || part?.inline_data?.data;
    const mimeIn = String(part?.mime_type || part?.inlineData?.mimeType || part?.inline_data?.mime_type || (modern ? "audio/l16;rate=8000" : "audio/L16;rate=24000"));
    if (!data) { errors.push(`${model}:no_audio`); continue; }
    const raw = decodeBase64(data);
    await onStage("tts_done", { tts_bytes: raw.length, tts_ms: Date.now() - started, tts_mime: mimeIn, voice_model: model });
    let bytes = raw, mime = mimeIn.split(";")[0].toLowerCase();
    if (/l16|pcm|wav/i.test(mimeIn)) {
      const rate = Number(part?.sample_rate || (mimeIn.match(/rate=(\d+)/i) || [])[1]) || (modern ? 8000 : 24000);
      const input = unpackPcm(raw, rate);
      await onStage("encode_start", { encode_provider:"cloudflare-chunks",sample_rate:8000,source_sample_rate:input.sampleRate });
      const encodingStarted=Date.now();
      const encoded=await encodePcmInChunks(input.pcm,input.sampleRate,env,fetchImpl,{onStage});
      bytes=encoded.bytes;
      await onStage("encode_done",{encode_bytes:bytes.length,encode_ms:Date.now()-encodingStarted,encode_provider:encoded.provider,encode_chunks:encoded.chunks,encode_fallback_used:encoded.fallback_used});
      mime = "audio/mpeg";
    } else {
      const format = audioFormat(mime);
      await onStage("encode_skipped_provider_encoded", { encode_provider: "provider", encode_bytes: bytes.length, format, mime });
    }
    if (!bytes?.length || bytes.length > 12 * 1024 * 1024) throw new Error("voice_tts_output_size_invalid");
    return Object.freeze({ bytes, mime, model, provider: "gemini", voice, language: "pt-BR", chars: text.length });
  }
  throw new Error(`voice_tts_gemini_failed:${errors.join(",").slice(0, 200)}`);
}

const PROVIDERS = Object.freeze({
  speechify: speechifyTts,
  azure: azureTts,
  "piper-relay": piperTts,
  gemini: geminiTts
});

export function voiceProviderStatus(env = {}) {
  const chain = chainFromEnv(env);
  return Object.freeze({
    chain,
    failover_enabled: String(env.VOICE_TTS_FAILOVER_ENABLED || "true").toLowerCase() === "true",
    zero_spend_enforced: String(env.VOICE_TTS_FREE_ONLY || "").toLowerCase() === "true",
    providers: Object.freeze(chain.map((provider) => {
      const state = breakerState(provider);
      return Object.freeze({
        provider,
        configured: isConfigured(provider, env),
        available: providerAvailable(provider, env),
        circuit_open: Boolean(state.openUntil && state.openUntil > Date.now()),
        failures: Number(state.failures || 0),
        last_success_at: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
        last_error: state.lastError || null
      });
    }))
  });
}

export async function ttsBytesWithFailover(text, env = {}, fetchImpl = globalThis.fetch, options = {}) {
  if (String(env.VOICE_TTS_FREE_ONLY || "").toLowerCase() !== "true") {
    throw new Error("voice_tts_zero_spend_guard_required");
  }
  const safe = cleanText(text);
  if (!safe) throw new Error("voice_tts_text_empty");
  const chain = chainFromEnv(env);
  const errors = [];
  for (const provider of chain) {
    const fn = PROVIDERS[provider];
    if (!fn || !providerAvailable(provider, env)) continue;
    try {
      const providerStarted=Date.now();
      const result = await fn(safe, env, fetchImpl, options);
      if(provider!=="gemini"){
        await options.onStage?.("tts_done",{tts_bytes:result.bytes.length,tts_ms:Date.now()-providerStarted,tts_mime:result.mime,voice_model:result.model});
        await options.onStage?.("encode_skipped_provider_encoded",{encode_provider:provider,encode_bytes:result.bytes.length,format:audioFormat(result.mime),mime:String(result.mime||"").split(";")[0].toLowerCase()});
      }
      noteSuccess(provider);
      return result;
    } catch (error) {
      noteFailure(provider, error);
      errors.push(`${provider}:${String(error?.message || error || "failed")}`);
      if (String(env.VOICE_TTS_FAILOVER_ENABLED || "true").toLowerCase() !== "true") break;
    }
  }
  throw new Error(`voice_tts_all_providers_failed:${errors.join("|").slice(0, 700)}`);
}
