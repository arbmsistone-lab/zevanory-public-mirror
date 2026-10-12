// Weekly end-to-end evaluation of the voice attendant on the real production models.
// For each sample: customer question -> audio (production voice) -> transcription (production
// Whisper) -> answer (production attendant, voice mode) -> answer audio (production voice) ->
// transcription again. Measures what a customer would experience: was the audio understood
// (WER in), was the answer correct (support battery checks), and is our spoken answer
// intelligible (WER out). Also proves the free fallback voice path. Stores only scores.
import { converse, speechText } from "./whatsapp-conversation.mjs";
import { BATTERY, scoreAnswer } from "./support-eval.mjs";

export const VOICE_EVAL_KEY = "zpc:support:v1:voice-eval";
export const WHISPER = "@cf/openai/whisper-large-v3-turbo";
export const SAMPLE_TAGS = ["preço", "reembolso", "recomendação"];
export const MAX_WER = 0.25;

const norm = (s) => String(s || "").replace(/&/g, " e ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/r\$\s*/g, "").replace(/(\d),(\d{2})\b/g, "$1 $2").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

// Word error rate: word-level Levenshtein distance over the reference length.
export function wer(reference, hypothesis) {
  const r = norm(reference), h = norm(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((1000 * prev[h.length]) / r.length) / 1000;
}

export function toBase64(bytes) {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function transcribe(ai, bytes) {
  const out = await ai.run(WHISPER, { audio: toBase64(bytes), task: "transcribe", language: "pt" });
  return String(out?.text || out?.transcription_info?.text || "").trim();
}

// deps: { ai, synth(text) -> {bytes, mime, provider, model}, fallbackSynth(text) -> same }
export async function runVoiceEval({ ai, synth, fallbackSynth }, { now = Date.now() } = {}) {
  const report = { schema: "zevanory-voice-eval/v1", generatedAt: new Date(now).toISOString(), samples: [], fallback: null, ok: false, failures: [] };
  if (!ai?.run || !synth) { report.failures.push("unconfigured"); return report; }
  const items = SAMPLE_TAGS.map((t) => BATTERY.find((b) => b.tag === t)).filter(Boolean);
  for (const item of items) {
    const s = { tag: item.tag, steps: {} };
    try {
      const qAudio = await synth(item.q);
      s.steps.questionAudio = { bytes: qAudio.bytes.length, provider: qAudio.provider, model: qAudio.model };
      const heard = await transcribe(ai, qAudio.bytes);
      s.werIn = wer(item.q, heard);
      const reply = await converse({ ai, question: heard, salesOpen: true, voice: true });
      const sc = scoreAnswer(item, reply);
      s.answer = { score: sc.score, checks: sc.checks, mode: reply?.mode || null };
      const speech = speechText(String(reply?.body || ""));
      const aAudio = await synth(speech);
      s.steps.answerAudio = { bytes: aAudio.bytes.length, provider: aAudio.provider, model: aAudio.model };
      s.werOut = wer(speech, await transcribe(ai, aAudio.bytes));
      s.ok = s.werIn <= MAX_WER && sc.score === 1 && s.werOut <= MAX_WER && qAudio.bytes.length > 2000 && aAudio.bytes.length > 2000;
    } catch (e) {
      s.ok = false; s.error = String(e?.message || e).slice(0, 160);
    }
    if (!s.ok) report.failures.push("sample:" + item.tag);
    report.samples.push(s);
  }
  if (fallbackSynth) {
    try {
      const text = "Olá, aqui é o atendimento da ZEVANORY.";
      const a = await fallbackSynth(text);
      const w = wer(text, await transcribe(ai, a.bytes));
      report.fallback = { provider: a.provider, model: a.model, bytes: a.bytes.length, wer: w, ok: a.bytes.length > 2000 && w <= MAX_WER };
    } catch (e) { report.fallback = { ok: false, error: String(e?.message || e).slice(0, 160) }; }
    if (!report.fallback.ok) report.failures.push("fallback_voice");
  }
  const ok = report.samples.filter((s) => s.ok).length;
  report.scorePct = report.samples.length ? Math.round((1000 * ok) / report.samples.length) / 10 : 0;
  report.ok = report.failures.length === 0;
  return report;
}
