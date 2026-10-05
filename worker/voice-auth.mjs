// Shared Render HMAC derivation; importing it does not load the legacy PCM encoder.
export async function renderVoiceSecret(env) {
  const e = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", e.encode(String(env.ELITE_INTERNAL_TOKEN || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, e.encode("zevanory-render-voice-v1")));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}
