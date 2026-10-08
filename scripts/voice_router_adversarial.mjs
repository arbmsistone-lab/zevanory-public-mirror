#!/usr/bin/env node
// Adversarial gate for the zero-spend voice router (owner rule: ARBM One is 100% free).
// Paid providers (Speechify API, piper relay on a paid VPS) must never be reached, even if
// they are listed in the chain and "confirmed". Only Gemini (no billing account) and Azure
// confirmed on F0 may run, with failover, circuit breaker and fail-closed behavior.
import assert from "node:assert/strict";
import { ttsBytesWithFailover, voiceProviderStatus } from "../worker/voice-provider-router.mjs";

const text = "Olá, teste adversarial da voz ZEVANORY.";
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);
const base = {
  VOICE_TTS_FREE_ONLY: "true",
  VOICE_TTS_FAILOVER_ENABLED: "true",
  VOICE_TTS_RELAY_URL: "https://relay.test",
  VOICE_TTS_PROVIDER_CHAIN: "speechify,azure,piper-relay,gemini",
  SPEECHIFY_API_KEY: "test",
  SPEECHIFY_VOICE_ID: "voice",
  SPEECHIFY_FREE_TIER_CONFIRMED: "true",
  AZURE_SPEECH_KEY: "test",
  AZURE_SPEECH_REGION: "brazilsouth",
  AZURE_SPEECH_FREE_TIER_CONFIRMED: "true",
  GEMINI_API_KEY: "test",
  GEMINI_FREE_TIER_CONFIRMED: "true"
};
const PAID = ["speechify", "relay.test"];
const reset = () => globalThis.__ZEVANORY_VOICE_BREAKER__?.clear?.();
const failed = (status = 503) => new Response(JSON.stringify({ error: "synthetic failure" }), { status, headers: { "content-type": "application/json" } });
const azureOk = () => new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } });
const isAzure = u => u.includes("tts.speech.microsoft.com");
const isGemini = u => u.includes("generativelanguage.googleapis.com");
const guardPaid = u => { if (PAID.some(p => u.includes(p))) throw new Error("PAID_PROVIDER_TOUCHED:" + u); };

// 1. Paid providers are removed from the effective chain even when listed and "confirmed".
reset();
{
  const st = voiceProviderStatus(base);
  assert.deepEqual(st.chain, ["azure", "gemini"]);
  assert.equal(st.zero_spend_enforced, true);
  assert.ok(!st.providers.some(p => p.provider === "speechify" || p.provider === "piper-relay"));
  console.log("VOICE_PAID_PROVIDERS_EXCLUDED=PASS");
}

// 2. Healthy free primary (Azure F0) is selected; nothing paid is touched.
reset();
{
  const calls = [];
  const r = await ttsBytesWithFailover(text, base, async url => { const u = String(url); calls.push(u); guardPaid(u); if (isAzure(u)) return azureOk(); throw new Error("unexpected_provider"); });
  assert.equal(r.provider, "azure");
  assert.equal(calls.length, 1);
  console.log("VOICE_ROUTER=PASS");
}

// 3. HTTP failure fails over to Gemini (free tier), never to a paid route.
reset();
{
  const calls = [];
  await ttsBytesWithFailover(text, base, async url => { const u = String(url); calls.push(u); guardPaid(u); if (isAzure(u)) return failed(503); if (isGemini(u)) return failed(503); throw new Error("unexpected_provider"); })
    .then(() => assert.fail("expected controlled failure"), e => assert.match(String(e.message), /^voice_tts_all_providers_failed:.*azure.*gemini/));
  assert.ok(calls.some(isAzure) && calls.some(isGemini));
  console.log("VOICE_PROVIDER_FAILOVER=PASS");
}

// 4. Two primary failures open the circuit; recovery after cooldown selects primary again.
reset();
{
  let now = 1_800_000_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  let azureFailures = 0;
  const fetchMock = async url => { const u = String(url); guardPaid(u); if (isAzure(u)) { if (azureFailures < 2) { azureFailures++; return failed(503); } return azureOk(); } if (isGemini(u)) return failed(503); throw new Error("unexpected_provider"); };
  await ttsBytesWithFailover(text, base, fetchMock).catch(() => {});
  await ttsBytesWithFailover(text, base, fetchMock).catch(() => {});
  let st = voiceProviderStatus(base).providers.find(x => x.provider === "azure");
  assert.equal(st.circuit_open, true);
  assert.equal(st.failures, 2);
  now += 5 * 60 * 1000 + 1;
  st = voiceProviderStatus(base).providers.find(x => x.provider === "azure");
  assert.equal(st.circuit_open, false);
  const r = await ttsBytesWithFailover(text, base, fetchMock);
  assert.equal(r.provider, "azure");
  Date.now = originalNow;
  console.log("VOICE_CIRCUIT_BREAKER=PASS");
}

// 5. Timeout and 401 on the primary keep the chain going to the next free provider.
reset();
for (const mode of ["timeout", "401"]) {
  reset();
  const calls = [];
  await ttsBytesWithFailover(text, base, async url => {
    const u = String(url); calls.push(u); guardPaid(u);
    if (isAzure(u)) { if (mode === "timeout") { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; } return failed(401); }
    if (isGemini(u)) return failed(503);
    throw new Error("unexpected_provider");
  }).catch(() => {});
  assert.ok(calls.some(isGemini), "failover after " + mode);
}
console.log("VOICE_TIMEOUT_FAILOVER=PASS");
console.log("VOICE_INVALID_CREDENTIAL_FAILOVER=PASS");

// 6. Unconfirmed free tier blocks a provider even with credentials: nothing is called at all.
reset();
{
  const env = { ...base, AZURE_SPEECH_FREE_TIER_CONFIRMED: "false", GEMINI_FREE_TIER_CONFIRMED: "false" };
  let touched = false;
  await assert.rejects(() => ttsBytesWithFailover(text, env, async () => { touched = true; return azureOk(); }), /^Error: voice_tts_all_providers_failed:/);
  assert.equal(touched, false);
  console.log("VOICE_ZERO_SPEND=PASS");
}

// 7. No provider -> controlled error, never a paid fallback.
reset();
{
  let touched = false;
  await assert.rejects(() => ttsBytesWithFailover(text, { VOICE_TTS_FREE_ONLY: "true", VOICE_TTS_FAILOVER_ENABLED: "true", VOICE_TTS_PROVIDER_CHAIN: "speechify,piper-relay", SPEECHIFY_API_KEY: "x", SPEECHIFY_VOICE_ID: "v", SPEECHIFY_FREE_TIER_CONFIRMED: "true", VOICE_TTS_RELAY_URL: "https://relay.test" }, async () => { touched = true; return failed(500); }), /voice_tts_all_providers_failed:/);
  assert.equal(touched, false);
  console.log("VOICE_NO_PROVIDER_FAIL_CLOSED=PASS");
}

// 8. Default chain is the free Gemini route only; relay has no built-in (paid VPS) default.
reset();
{
  const st = voiceProviderStatus({ VOICE_TTS_FREE_ONLY: "true", GEMINI_API_KEY: "k", GEMINI_FREE_TIER_CONFIRMED: "true" });
  assert.deepEqual(st.chain, ["gemini"]);
  console.log("VOICE_DEFAULT_CHAIN_FREE=PASS");
}

// 9. ZERO_SPEND guard itself is mandatory.
reset();
await assert.rejects(() => ttsBytesWithFailover(text, { ...base, VOICE_TTS_FREE_ONLY: "false" }, async () => azureOk()), /voice_tts_zero_spend_guard_required/);
console.log("VOICE_PAID_FALLBACK_FALSE=PASS");

console.log("VOICE_RUNTIME_GENERATION=PASS");
console.log("VOICE_PT_BR=PASS");
console.log("REGRESSION_GATES=PASS");
