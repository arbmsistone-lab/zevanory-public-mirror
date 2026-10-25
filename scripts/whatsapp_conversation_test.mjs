import {handleVoiceChunk} from "../worker/voice-chunks.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateReply, converse, deterministicReply, speechText, voiceReplyBody } from "../worker/whatsapp-conversation.mjs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { pcm16ToMp3, ttsBytesWithFailover } from "../worker/voice-provider-router.mjs";
import { handleWhatsappOnboarding, loadVoiceGeminiKey } from "../worker/whatsapp-onboarding.mjs";

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
  ELITE_INTERNAL_TOKEN:"unit-test-master-material-32-chars", VOICE_TTS_FREE_ONLY: "true", GEMINI_API_KEY: "unit-test-only", GEMINI_FREE_TIER_CONFIRMED: "true", VOICE_TTS_PROVIDER_CHAIN: "gemini,piper-relay"
}, async (url, init) => {
  if(url instanceof Request)return handleVoiceChunk(url,{ELITE_INTERNAL_TOKEN:"unit-test-master-material-32-chars"});
  geminiCalls++;
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  assert.equal(init.headers["x-goog-api-key"], "unit-test-only");
  assert.deepEqual(JSON.parse(init.body).response_format, { type: "audio", mime_type: "audio/l16", sample_rate: 8000 });
  return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/l16", sample_rate: 8000, data: Buffer.from(pcm).toString("base64") }] }] });
});
check("Gemini audio contract and MP3", () => { assert.equal(geminiCalls, 1); assert.equal(voice.provider, "gemini"); assert.equal(voice.mime, "audio/mpeg"); assert.equal(voice.bytes[0], 0xff); });

// WhatsApp channel retired: the onboarding panel and voice-key routes are 410 Gone; only the Gemini
// voice key may still be read from the old encrypted record, never the WhatsApp credentials.
const master = "unit-test-master-material-32-chars", fakeKey = "unit-test-gemini-private-key";
const enc = new TextEncoder(), iv = crypto.getRandomValues(new Uint8Array(12));
const aes = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("zevanory:whatsapp:onboarding:v1:" + master)), { name: "AES-GCM" }, false, ["encrypt"]);
const sealedRecord = Buffer.from(iv).toString("base64url") + "." + Buffer.from(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify({ gemini_api_key: fakeKey, access_token: "unit-test-wa-token", phone_number_id: "1300972319774588", app_secret: "unit-test-app-secret", verify_token: "unit-test-verify", identity_verified: true })))).toString("base64url");
const env = { ELITE_INTERNAL_TOKEN: master, ZEVANORY_PRIVATE_ARTIFACTS: { async get(k) { return k === "whatsapp-onboarding/runtime" ? sealedRecord : null; }, async put() { throw new Error("must_not_write"); } } };
const originalFetch = globalThis.fetch;
try {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("network_forbidden"); };
  const voiceKey = await loadVoiceGeminiKey(env);
  check("only the Gemini voice key leaves the sealed record", () => { assert.equal(voiceKey, fakeKey); assert.equal(typeof voiceKey, "string"); });
  const noKey = await loadVoiceGeminiKey({}), wrongMaster = await loadVoiceGeminiKey({ ...env, ELITE_INTERNAL_TOKEN: "another-master-material-32-chars!!" });
  check("missing or unreadable record yields no key", () => { assert.equal(noKey, ""); assert.equal(wrongMaster, ""); });
  for (const [path, method] of [["/admin/whatsapp-onboard", "GET"], ["/admin/whatsapp-onboard/voice-key", "POST"]]) {
    const r = await handleWhatsappOnboarding(new Request("https://zevanory.api.br" + path, { method, headers: { origin: "https://zevanory.api.br" }, body: method === "POST" ? new URLSearchParams({ gemini_api_key: fakeKey }) : undefined }), env);
    const text = await r.text();
    check(`retired onboarding route ${path} answers 410 without secrets`, () => { assert.equal(r.status, 410); assert.ok(!text.includes(fakeKey)); assert.ok(!text.includes("unit-test-wa-token")); });
  }
  check("no network call from retired onboarding", () => assert.equal(calls, 0));
} finally { globalThis.fetch = originalFetch; }

check("deployment retains AI binding and closed sales", () => { const source = readFileSync(new URL("./deploy/prepare-central-candidate.py", import.meta.url), "utf8"); assert.match(source, /c\["ai"\]=\{"binding":"AI"\}/); assert.match(source, /c\["vars"\]\["SALE_GLOBALLY_ENABLED"\]="false"/); });
console.log(`WHATSAPP_CONVERSATION_TEST=PASS checks=${checks}`);

check("reject multiple customer questions",()=>assert.equal(validateReply("Qual seu negócio? Qual seu objetivo?").ok,false));
check("spoken summary keeps full text separate",()=>{const original="Olá! "+("Esta orientação ajuda a organizar o atendimento e melhorar as vendas. ").repeat(10)+" https://vendas.zevanory.api.br/combo-ia-vendas";const voice=speechText(original);assert.ok(voice.length<=350);assert.ok(!voice.includes("https://"));assert.ok(voice.endsWith("Os detalhes estão na mensagem de texto."));assert.ok(original.length>600);});

const {voiceCacheKey} = await import("../worker/voice-remote-tts.mjs");
const alternativeAI = await converse({question,ai:{async run(){return {response:"Por R$ 297,00 você leva o Combo IA + Vendas. Quer conhecer o material?"};}}});
assert.notEqual(validAI.body,alternativeAI.body);
assert.equal(await voiceCacheKey(speechText(voiceReplyBody(question,validAI.body))),await voiceCacheKey(speechText(voiceReplyBody(question,alternativeAI.body))));
for(const q of ["Como recebo o combo?","Quero reembolso do combo"]){assert.equal(speechText(voiceReplyBody(q,"fala variável da IA")),speechText(deterministicReply(q).body));}
const outside="Como organizar minha rotina de trabalho?";
assert.equal(voiceReplyBody(outside,"Vamos organizar sua rotina juntos."),"Vamos organizar sua rotina juntos.");
assert.equal(voiceReplyBody("Quanto custa o produto que não existe?","Qual produto?"),"Qual produto?");
const runtime=readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs",import.meta.url),"utf8");
assert.match(runtime,/whatsappSpeechText\(voiceReplyBody\(question, reply.body\)\)/);
assert.doesNotMatch(runtime,/voice_synth_fallback/);
console.log("DETERMINISTIC_CATALOG_VOICE_AI_TEXT_PRESERVED=PASS");
