import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateReply, converse, deterministicReply, speechText } from "../worker/whatsapp-conversation.mjs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { pcm16ToMp3, ttsBytesWithFailover } from "../worker/voice-provider-router.mjs";
import { handleWhatsappOnboarding, loadWhatsappRuntimeCredentials } from "../worker/whatsapp-onboarding.mjs";

let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
for (const text of ["R$ 150", "R$ 297,50", "https://example.com/pagar", "https://vendas.zevanory.api.br.evil.example/combo-ia-vendas", "20% de desconto"]) {
  check(`reject ${text}`, () => assert.equal(validateReply(text).ok, false));
}
for (const [slug, p] of Object.entries(SUPPORT_PRODUCTS)) {
  check(`official ${slug}`, () => assert.equal(validateReply(`${p.name}: R$ ${p.price_brl},00 https://vendas.zevanory.api.br/${slug}`).ok, true));
}
for (const path of ["", "/", "/solucoes", "/reembolso", "/privacidade", "/termos"]) {
  check(`official page ${path || "origin"}`, () => assert.equal(validateReply(`https://vendas.zevanory.api.br${path}`).ok, true));
}
const question = "Quanto custa o combo?";
let aiCalls = 0;
const invented = await converse({ question, ai: { async run() { aiCalls++; return { response: "O combo custa R$ 150." }; } } });
check("hallucinated price -> grounded_fallback", () => {
  assert.equal(invented.mode, "grounded_fallback");
  assert.equal(invented.body, deterministicReply(question).body);
  assert.match(invented.body, /R\$ 297,00/);
  assert.equal(aiCalls, 3);
});
const offline = await converse({ question });
check("no AI -> fixed grounded answer", () => { assert.equal(offline.mode, "grounded"); assert.equal(offline.body, invented.body); });
const validAI = await converse({ question, ai: { async run() { return { response: "O Combo IA + Vendas custa R$ 297,00. https://vendas.zevanory.api.br/combo-ia-vendas" }; } } });
check("approved AI response accepted", () => { assert.equal(validAI.mode, "ai_grounded"); assert.ok(validAI.model); });
const recommendation = await converse({ question: "quero melhorar minhas vendas, o que recomenda?" });
check("consultative recommendation remains available on AI failure", () => { assert.match(recommendation.body, /Vendas na Prática/); assert.match(recommendation.body, /R\$ 197,00/); assert.equal(validateReply(recommendation.body).ok, true); });
check("speech removes links", () => { const spoken = speechText("Veja https://vendas.zevanory.api.br/combo-ia-vendas por R$ 297,00."); assert.doesNotMatch(spoken, /https?:\/\//); assert.match(spoken, /297 reais/); });

const pcm = new Uint8Array(24000 * 2);
const view = new DataView(pcm.buffer);
for (let i = 0; i < 24000; i++) view.setInt16(i * 2, Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000), true);
const mp3 = pcm16ToMp3(pcm);
check("PCM -> valid MP3 frame", () => { assert.ok(mp3.length > 100); assert.equal(mp3[0], 0xff); assert.ok([0xf3, 0xfb].includes(mp3[1])); });

// Provider simulation verifies Gemini's wire contract and PCM conversion without a key or cost.
let geminiCalls = 0;
const voice = await ttsBytesWithFailover("Olá, podemos melhorar suas vendas.", {
  VOICE_TTS_FREE_ONLY: "true", GEMINI_API_KEY: "unit-test-only", GEMINI_FREE_TIER_CONFIRMED: "true", VOICE_TTS_PROVIDER_CHAIN: "gemini,piper-relay"
}, async (url, init) => {
  geminiCalls++;
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  assert.equal(init.headers["x-goog-api-key"], "unit-test-only");
  assert.deepEqual(JSON.parse(init.body).generationConfig.responseModalities, ["AUDIO"]);
  return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: Buffer.from(pcm).toString("base64") } }] } }] });
});
check("Gemini audio contract and MP3", () => { assert.equal(geminiCalls, 1); assert.equal(voice.provider, "gemini"); assert.equal(voice.mime, "audio/mpeg"); assert.equal(voice.bytes[0], 0xff); });

// Encrypted KV round trip, failures and rendering must never leak the supplied key.
const kv = new Map();
const env = { ELITE_INTERNAL_TOKEN: "unit-test-master-material-32-chars", ZEVANORY_PRIVATE_ARTIFACTS: { async get(k) { return kv.get(k) || null; }, async put(k, v) { kv.set(k, v); } } };
const originalFetch = globalThis.fetch;
const fakeKey = "unit-test-gemini-private-key";
const request = (key, origin = "https://zevanory.api.br") => new Request("https://zevanory.api.br/admin/whatsapp-onboard/voice-key", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ gemini_api_key: key }) });
try {
  globalThis.fetch = async (url, init) => { assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models"); assert.equal(init.headers["x-goog-api-key"], fakeKey); return Response.json({ models: [] }); };
  const saved = await handleWhatsappOnboarding(request(fakeKey), env);
  const runtime = await loadWhatsappRuntimeCredentials(env);
  check("validated voice key encrypted and available to runtime", () => { assert.equal(saved.status, 303); assert.equal(runtime.gemini_api_key, fakeKey); assert.doesNotMatch(kv.get("whatsapp-onboarding/runtime"), /unit-test-gemini/); });
  const page = await (await handleWhatsappOnboarding(new Request("https://zevanory.api.br/admin/whatsapp-onboard"), env)).text();
  check("panel shows configured voice without secret", () => { assert.match(page, /Voz \(Gemini grátis\).*configurada/); assert.ok(!page.includes(fakeKey)); assert.match(page, /type="password" name="gemini_api_key"/); });
  const before = kv.get("whatsapp-onboarding/runtime");
  globalThis.fetch = async () => Response.json({ error: { message: "never expose provider message" } }, { status: 403 });
  const rejected = await handleWhatsappOnboarding(request("invalid-key"), env);
  check("non-200 cannot overwrite stored voice key", () => { assert.equal(rejected.status, 400); assert.equal(kv.get("whatsapp-onboarding/runtime"), before); });
  globalThis.fetch = async () => { throw new Error("provider-network-failure"); };
  const unavailable = await handleWhatsappOnboarding(request("invalid-key"), env);
  check("network failure cannot overwrite stored voice key", () => { assert.equal(unavailable.status, 503); assert.equal(kv.get("whatsapp-onboarding/runtime"), before); });
  const csrf = await handleWhatsappOnboarding(request(fakeKey, "https://evil.example"), env);
  check("cross-origin voice-key request rejected", () => assert.equal(csrf.status, 403));
} finally { globalThis.fetch = originalFetch; }

check("deployment retains AI binding and closed sales", () => { const source = readFileSync(new URL("./deploy/prepare-central-candidate.py", import.meta.url), "utf8"); assert.match(source, /c\["ai"\]=\{"binding":"AI"\}/); assert.match(source, /c\["vars"\]\["SALE_GLOBALLY_ENABLED"\]="false"/); });
console.log(`WHATSAPP_CONVERSATION_TEST=PASS checks=${checks}`);
