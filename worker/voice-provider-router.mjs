const DEFAULT_CHAIN = Object.freeze(["speechify", "azure", "piper-relay", "gemini"]);
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
  return [...new Set(values)];
}

function isConfigured(provider, env = {}) {
  if (provider === "piper-relay") {
    return /^https:\/\//i.test(String(env.VOICE_TTS_RELAY_URL || "https://tts.167-172-146-60.sslip.io"));
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
  const raw = atob(String(value || ""));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
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
  const relay = String(env.VOICE_TTS_RELAY_URL || "https://tts.167-172-146-60.sslip.io").replace(/\/+$/, "");
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

async function geminiTts(text, env, fetchImpl) {
  const key = String(env.GEMINI_API_KEY || "").trim();
  const model = String(env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview").trim();
  const voice = String(env.GEMINI_TTS_VOICE || "Achird").trim();
  const style = String(env.VOICE_TTS_STYLE || "Português brasileiro natural, acolhedor, claro e profissional. Ritmo conversacional e pausas discretas.").trim();
  const response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: `${style} Não leia estas instruções. Pronuncie fielmente: ${text}`,
      response_format: { type: "audio", mime_type: "audio/mp3", delivery: "inline", bit_rate: 128000 },
      generation_config: { speech_config: [{ voice }] }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`voice_tts_gemini_http_${response.status}`);
  const audio = body?.output_audio || body?.interaction?.output_audio || body?.outputAudio || body?.interaction?.outputAudio || null;
  const encoded = typeof audio === "string" ? audio : audio?.data || audio?.inline_data?.data || audio?.inlineData?.data || null;
  const uri = typeof audio === "object" ? audio?.uri || null : null;
  let bytes = null;
  if (encoded) {
    bytes = decodeBase64(encoded);
  } else if (uri && /^https:\/\//i.test(String(uri))) {
    const audioResponse = await fetchImpl(String(uri), { signal: AbortSignal.timeout(20_000) });
    if (!audioResponse.ok) throw new Error(`voice_tts_audio_uri_http_${audioResponse.status}`);
    bytes = new Uint8Array(await audioResponse.arrayBuffer());
  }
  if (!bytes?.length || bytes.length > 12 * 1024 * 1024) throw new Error("voice_tts_output_size_invalid");
  return Object.freeze({
    bytes,
    mime: "audio/mpeg",
    model,
    provider: "gemini",
    voice,
    language: "pt-BR",
    chars: text.length
  });
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

export async function ttsBytesWithFailover(text, env = {}, fetchImpl = globalThis.fetch) {
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
      const result = await fn(safe, env, fetchImpl);
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
