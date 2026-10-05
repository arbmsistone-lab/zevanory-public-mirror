// WhatsApp voice without Worker CPU: the Render backend runs Gemini TTS and the MP3
// encoding; the Worker only signs a small JSON request, caches the returned MP3 in KV
// (repeated catalog answers cost no Gemini quota) and forwards the bytes to Meta.
import { renderVoiceSecret } from "./voice-chunks.mjs";
export const SYNTH_URL = "https://zevanory-product-control-edge.onrender.com/api/voice/synthesize";
export const SYNTH_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const E = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function voiceCacheKey(text, voice = "Achird") {
  return `voice-cache:v1:${hex(await crypto.subtle.digest("SHA-256", E.encode(`${voice}\n${String(text).trim()}`)))}`;
}

export async function signSynthRequest(raw, secret) {
  const timestamp = String(Date.now()), nonce = crypto.randomUUID();
  const digest = hex(await crypto.subtle.digest("SHA-256", raw));
  const key = await crypto.subtle.importKey("raw", E.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, E.encode(["zevanory-voice-synth-v1", timestamp, nonce, digest].join("\n"))));
  return { "content-type": "application/json", "x-voice-timestamp": timestamp, "x-voice-nonce": nonce, "x-voice-signature": signature };
}

const validMp3 = (b) => b.length > 64 && ((b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33));

// Returns { bytes, mime, provider, model, cached }. Throws Error with a stable code.
export async function synthesizeVoice(text, { apiKey, env = {}, kv = null, fetchImpl = fetch, secret = null, voice = "Achird", onStage = async () => {} } = {}) {
  const speech = String(text || "").trim().slice(0, 1200);
  if (!speech) throw new Error("voice_text_empty");
  const cacheKey = await voiceCacheKey(speech, voice);
  if (kv?.get) {
    const hit = await kv.get(cacheKey, "arrayBuffer").catch(() => null);
    if (hit && hit.byteLength) {
      await onStage("tts_done", { voice_cached: true });
      return { bytes: new Uint8Array(hit), mime: "audio/mpeg", provider: "cache", model: "cache", cached: true };
    }
  }
  if (!apiKey) throw new Error("voice_gemini_key_missing");
  const sharedSecret = secret || await renderVoiceSecret(env);
  const raw = E.encode(JSON.stringify({ text: speech, api_key: apiKey, voice, models: SYNTH_MODELS }));
  let response = null, lastError = "voice_synth_unreachable";
  for (let attempt = 0; attempt < 2 && !response; attempt++) {
    try {
      // Render free instances sleep; the first call can take ~50 s to wake up.
      const r = await fetchImpl(String(env.VOICE_SYNTH_URL || SYNTH_URL), { method: "POST", headers: await signSynthRequest(raw, sharedSecret), body: raw, signal: AbortSignal.timeout(attempt === 0 ? 70000 : 30000) });
      if (r.ok) { response = r; break; }
      const body = await r.json().catch(() => ({}));
      lastError = r.status === 429 && body?.error === "gemini_quota" ? "quota" : `voice_synth_http_${r.status}:${String(body?.error || "").slice(0, 80)}`;
      if (r.status === 429 || r.status === 400 || r.status === 401) break;
    } catch (error) {
      lastError = `voice_synth_${String(error?.name === "TimeoutError" ? "timeout" : error?.message || "failed").slice(0, 80)}`;
    }
  }
  if (!response) throw new Error(lastError);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!validMp3(bytes) || bytes.length > 12 * 1024 * 1024) throw new Error("voice_synth_invalid_mp3");
  const model = String(response.headers.get("x-voice-model") || "gemini");
  await onStage("tts_done", { voice_cached: false, voice_bytes: bytes.length });
  if (kv?.put) await kv.put(cacheKey, bytes, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
  return { bytes, mime: "audio/mpeg", provider: "render-gemini", model, cached: false };
}
