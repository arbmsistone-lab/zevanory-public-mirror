import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { deferMetaWebhook, whatsappStageRecorder, handleNodeWebhookFetch, latestWhatsappStage } from "../worker/whatsapp-background.mjs";
import { unpackPcm, encodePcmRemotely } from "../worker/voice-pcm.mjs";
import { pcm16ToMp3, ttsBytesWithFailover } from "../worker/voice-provider-router.mjs";

let pending, release, finished = false, handlerStarted = false;
const request = new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", headers: { "x-hub-signature-256": "synthetic-signature" }, body: '{"entry":[]}' });
const response = deferMetaWebhook(request, {}, { waitUntil(p) { pending = p; } }, async clone => {
  handlerStarted = true;
  assert.equal(clone.headers.get("x-hub-signature-256"), "synthetic-signature");
  assert.equal(await clone.text(), '{"entry":[]}');
  await new Promise(resolve => { release = resolve; });
  finished = true;
  return Response.json({ processed: true });
});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { accepted: true });
assert.equal(finished, false);
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(handlerStarted, true);
release(); await pending;
assert.equal(finished, true);
assert.equal(deferMetaWebhook(new Request("https://zevanory.api.br/api/webhooks/meta"), {}, {}, () => {}), null);
assert.equal(deferMetaWebhook(request, {}, {}, () => {}).status, 503);
console.log("META_IMMEDIATE_ACK_WAITUNTIL_CLONED_BODY=PASS");

let clock = 0;
const snapshots = [], pointers = [], state = { heard: true, text_sent: false, voice_sent: false, voice_error: null };
const checkpoint = whatsappStageRecorder({ async put(key, value) { if (key === "whatsapp:instant:last") pointers.push({ at: clock, value: JSON.parse(value) }); else { assert.ok(key.startsWith("whatsapp:instant:stage:")); snapshots.push(JSON.parse(value)); } } }, state, () => clock += 2, async ms => { clock += ms; });
for (const stage of ["heard", "ai_done", "text_sent", "tts_start", "tts_done", "encode_start", "encode_done", "upload_done", "voice_sent"]) {
  await checkpoint(stage, stage === "text_sent" ? { text_sent: true } : stage === "voice_sent" ? { voice_sent: true } : {});
}
assert.deepEqual(snapshots.map(x => x.stage), ["heard", "ai_done", "text_sent", "tts_start", "tts_done", "encode_start", "encode_done", "upload_done", "voice_sent"]);
assert.equal(snapshots[2].text_sent, true);
assert.equal(snapshots[8].voice_sent, true);
assert.equal(snapshots[4].voice_sent, false);
await checkpoint("voice_error", { voice_sent: false, voice_error: "synthetic_failure" });
assert.equal(snapshots.at(-1).voice_error, "synthetic_failure");
assert.equal(snapshots.at(-1).steps.at(-1).stage, "voice_error");
console.log("CHECKPOINT_EVERY_STAGE_AND_ERROR=PASS");

const pcm = new Uint8Array(16000);
for (let i = 0; i < pcm.length / 2; i++) new DataView(pcm.buffer).setInt16(i * 2, Math.round(Math.sin(i / 3) * 3000), true);
const encodingStart = process.cpuUsage();
const mp3 = pcm16ToMp3(pcm, 8000, 32);
const cpu = process.cpuUsage(encodingStart);
assert.equal(mp3[0], 0xff); assert.equal(mp3[1] & 0xe0, 0xe0);
console.log(`LOCAL_ENCODER_CPU_BENCHMARK_MS=${(cpu.user + cpu.system) / 1000} (Node measurement, not production CPU evidence)`);
const wav = new Uint8Array(44 + pcm.length), v = new DataView(wav.buffer);
wav.set(new TextEncoder().encode("RIFF")); v.setUint32(4, wav.length - 8, true); wav.set(new TextEncoder().encode("WAVEfmt "), 8);
v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
wav.set(new TextEncoder().encode("data"), 36); v.setUint32(40, pcm.length, true); wav.set(pcm, 44);
assert.deepEqual(unpackPcm(wav).pcm, pcm);
assert.equal(unpackPcm(wav).sampleRate, 8000);
assert.throws(() => unpackPcm(new Uint8Array(3 * 1024 * 1024 + 2)), /size/);
console.log("WAV_PCM_BOUNDARIES=PASS");

const secret = "synthetic-test-shared-hmac-material";
const remote = { VOICE_ENCODE_URL: "https://encoder.example/api/voice/encode", VOICE_ENCODE_SECRET: secret };
let called = false;
const fetchRemote = async (url, init) => {
  called = true;
  assert.equal(url, remote.VOICE_ENCODE_URL); assert.equal(init.headers["content-type"], "application/octet-stream");
  const digest = createHash("sha256").update(init.body).digest("hex");
  const h = init.headers;
  const message = `${h["x-voice-timestamp"]}\n${h["x-voice-nonce"]}\n8000\n${digest}`;
  assert.equal(h["x-voice-signature"], createHmac("sha256", secret).update(message).digest("hex"));
  assert.ok(!JSON.stringify(init.headers).includes(secret));
  return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
};
assert.deepEqual(await encodePcmRemotely(pcm, 8000, remote, fetchRemote), mp3);
assert.equal(called, true);
await assert.rejects(() => encodePcmRemotely(pcm, 8000, remote, async () => new Response("no", { status: 401 })), /voice_encode_http_401/);
await assert.rejects(() => encodePcmRemotely(pcm, 8000, remote, async () => new Response("invalid")), /invalid_mp3/);
console.log("ALTERNATE_ENCODER_HMAC_FAIL_CLOSED=PASS");

const stages = [];
const audio = await ttsBytesWithFailover("Olá!", { ...remote, VOICE_TTS_FREE_ONLY: "true", GEMINI_API_KEY: "synthetic", GEMINI_FREE_TIER_CONFIRMED: "true", VOICE_TTS_PROVIDER_CHAIN: "gemini" }, async (url, init) => {
  if (String(url).includes("googleapis")) {
    const request = JSON.parse(init.body);
    assert.equal(request.model, "gemini-3.8-flash-tts");
    assert.equal(request.response_format.sample_rate, 8000);
    return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") }] }] });
  }
  return fetchRemote(url, init);
}, { onStage: async (stage, details) => stages.push({ stage, ...details }) });
assert.equal(audio.mime, "audio/mpeg");
assert.deepEqual(stages.map(x => x.stage), ["tts_done", "encode_start", "encode_done"]);
assert.equal(stages[1].encode_provider, "render");
assert.ok(stages[0].tts_bytes > 0); assert.ok(stages[2].encode_bytes > 0);
const workerSource = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
assert.ok(workerSource.indexOf('await checkpoint("text_sent")') < workerSource.indexOf('await checkpoint("tts_start")'));
assert.match(workerSource, /if \(!localSignatureValid && !brokerSignatureValid\) return json14\(res, 401/);
console.log("GEMINI_38_8KHZ_REMOTE_STAGES_SIGNATURE_PRESERVED=PASS");
console.log("WHATSAPP_AUDIO_RUNTIME=PASS");

const handlerSource = workerSource.slice(workerSource.indexOf("async function handler18(req, res) {"), workerSource.indexOf('__name(handler18, "handler")'));
async function exerciseInbound(database) {
  const order = [], captured = [], kv = { async put(_key, value) { if (_key.startsWith("whatsapp:instant:stage:")) captured.push(JSON.parse(value)); } };
  const item = { from: "synthetic-contact", type: "audio", media_id: "synthetic-media", message_id: "synthetic-message" };
  const sandbox = {
    process: { env: { DATABASE_URL: database ? "synthetic-database" : "" } },
    globalThis: { __ZEVANORY_PRIVATE_KV__: kv, __ZEVANORY_WHATSAPP_RUNTIME__: {} },
    rawText: () => '{}', verifyMetaSignature: () => true, whatsappBrokerSignatureValid: async () => false,
    extractWhatsappInboundMessages: () => [item], cs: () => ({ query: async () => [] }),
    whatsappStageRecorder, Date,
    understandWhatsappInbound: async () => { assert.equal(captured[0].stage, "received"); order.push("understand"); return { ...item, transcript: "Olá", understanding: "Olá" }; },
    replyWhatsappConversation: async (_item, question, { status, checkpoint }) => { assert.equal(question, "Olá"); order.push("reply"); await checkpoint("voice_sent", { heard: true, text_sent: true, voice_sent: true }); return { sent: true, ...status }; },
    queueWhatsappConversation: async () => { assert.ok(order.includes("reply")); order.push("archive"); return { queued: true, job_id: "synthetic", kind: "support" }; },
    recordWhatsappEvidence: async () => { assert.ok(order.includes("reply")); order.push("evidence"); },
    json14: (_res, code, body) => ({ code, body })
  };
  vm.createContext(sandbox); vm.runInContext(handlerSource, sandbox);
  const result = await sandbox.handler18({ method: "POST", headers: {} }, { setHeader() {} });
  assert.equal(result.code, 200); assert.equal(result.body.instant_replies, 1);
  assert.deepEqual(captured.map(x => x.stage), ["received", "stt_start", "stt_done", "voice_sent"]);
  assert.equal(order.includes("archive"), database);
  assert.equal(captured.at(-1).voice_sent, true);
}
await exerciseInbound(true); await exerciseInbound(false);
console.log("INBOUND_CHECKPOINT_BEFORE_STT_REPLY_BEFORE_CRM_NO_DATABASE=PASS");

const signedBody = JSON.stringify({ text: "áudio em português", entry: [] });
const signature = "sha256=" + createHmac("sha256", "synthetic-meta-secret").update(signedBody).digest("hex");
const signedRequest = new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", headers: { "x-hub-signature-256": signature }, body: signedBody });
const directResult = await handleNodeWebhookFetch(signedRequest, async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  assert.equal(raw.toString(), signedBody);
  assert.equal(req.query.provider, "meta");
  assert.equal(req.headers["x-hub-signature-256"], "sha256=" + createHmac("sha256", "synthetic-meta-secret").update(raw).digest("hex"));
  res.setHeader("content-type", "application/json"); res.statusCode = 200; res.end('{"accepted":true}');
});
assert.equal(directResult.status, 200); assert.equal((await directResult.json()).accepted, true);
const oversized = await handleNodeWebhookFetch(new Request("https://zevanory.api.br/api/webhooks/meta", { method: "POST", body: "oversized" }), () => { throw new Error("must_not_call_handler"); }, 3);
assert.equal(oversized.status, 413);
console.log("DIRECT_WEB_REQUEST_SIGNED_BYTES_SIZE_BOUNDARY=PASS");

for (let i = 1; i < pointers.length; i++) assert.ok(pointers[i].at - pointers[i - 1].at >= 1000);
assert.equal(pointers.at(-1).value.stage, "voice_error");
const fresh = { at: "2026-10-04T20:50:00Z", elapsed_ms: 40, stage: "encode_start" };
const historical = { at: "2026-10-04T19:55:11Z", text_sent: true };
assert.deepEqual(await latestWhatsappStage({ get: async key => JSON.stringify(key === "whatsapp:instant:last" ? historical : fresh), list: async () => ({ keys: [{ name: "whatsapp:instant:stage:synthetic" }] }) }), fresh);
console.log("KV_SAME_KEY_RATE_LIMIT_ALL_STAGES_RETAINED=PASS");
