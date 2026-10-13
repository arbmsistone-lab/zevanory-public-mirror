import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wer, toBase64, runVoiceEval, SAMPLE_TAGS } from "../worker/voice-eval.mjs";

test("word error rate", () => {
  assert.equal(wer("Quanto custa o Lucro & Caixa?", "quanto custa o lucro e caixa"), 0);
  assert.equal(wer("um dois três quatro", "um dois tres quatro"), 0);
  assert.equal(wer("um dois três quatro", "um dois"), 0.5);
  assert.equal(wer("", ""), 0);
});

test("base64 of binary audio round-trips", () => {
  const b = new Uint8Array(70000).map((_, i) => i % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(b), "base64")), b);
});

// Fake production stack: the "audio" carries its text so transcription can be simulated.
const enc = new TextEncoder(), dec = new TextDecoder();
const audio = (t) => ({ bytes: enc.encode(t.padEnd(3000, " ")), provider: "fake", model: "fake" });
function fakeAi({ garble = false, wrongPrice = false } = {}) {
  return {
    async run(model, input) {
      if (model.includes("whisper")) { const t = dec.decode(Buffer.from(input.audio, "base64")).trim(); return { text: garble ? "xx yy zz" : t }; }
      const q = JSON.stringify(input.messages || input);
      const body = /reembolso|dinheiro de volta/i.test(q) ? "Você tem 7 dias de garantia para pedir reembolso pela Hotmart." :
        /lucro/i.test(q) ? (wrongPrice ? "O Lucro & Caixa custa R$ 99,00." : "O Lucro & Caixa custa R$ 247,00.") :
        "Para começar a vender mais, o Vendas na Prática é o indicado, e o Combo IA + Vendas junta os dois.";
      return { response: body };
    },
  };
}

test("passes only when audio is understood, the answer is right and our voice is intelligible", async () => {
  const ok = await runVoiceEval({ wait: async () => {}, ai: fakeAi(), synth: async (t) => audio(t), fallbackSynth: async (t) => audio(t) });
  assert.equal(ok.samples.length, SAMPLE_TAGS.length + 2, "core + 2 rotating");
  for (const s of ok.samples) { assert.ok(s.werIn <= 0.25, JSON.stringify(s)); assert.ok(s.werOut <= 0.25); }
  const garbled = await runVoiceEval({ wait: async () => {}, ai: fakeAi({ garble: true }), synth: async (t) => audio(t), fallbackSynth: async (t) => audio(t) });
  assert.equal(garbled.ok, false); assert.equal(garbled.fallback.ok, false);
  const down = await runVoiceEval({ wait: async () => {}, ai: fakeAi(), synth: async () => { throw new Error("voice_synth_http_404"); }, fallbackSynth: async (t) => audio(t) });
  assert.equal(down.ok, false); assert.ok(down.samples.every((s) => /404/.test(s.error)));
});

test("endpoint is authenticated, uncached and stores only the report", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf('"/api/internal/voice-eval/run"'), src.indexOf('"/api/zea10/autonomy"'));
  assert.match(block, /backupTokenOk\(request\.headers\.get\("x-backup-token"\)/);
  assert.match(block, /kv: null/);
});

test("a free-tier rate limit is retried once after a pause, not reported as a voice defect", async () => {
  let calls = 0;
  const flaky = async (t) => { calls++; if (calls === 1) throw new Error("quota"); return audio(t); };
  const r = await runVoiceEval({ wait: async () => {}, ai: fakeAi(), synth: flaky, fallbackSynth: async (t) => audio(t) });
  assert.equal(r.samples[0].error, undefined, JSON.stringify(r.samples[0]));
  assert.ok(r.samples[0].steps.questionAudio.bytes > 2000, "audio produced after the retry");
});

import { voiceSamples } from "../worker/voice-eval.mjs";
test("voice samples: fixed core plus two rotating questions; the whole battery is covered over the weeks", () => {
  const week = 7 * 864e5;
  const seen = new Set();
  for (let w = 0; w < 12; w++) { const s = voiceSamples(w * week); assert.equal(s.length, 5); assert.deepEqual(s.slice(0, 3).map((x) => x.tag), ["preço", "reembolso", "recomendação"]); s.forEach((x) => seen.add(x.q)); }
  assert.ok(seen.size >= 15, "battery covered: " + seen.size);
});
