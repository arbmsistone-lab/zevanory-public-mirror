// Triggers the weekly end-to-end voice evaluation inside the production Worker (real Whisper,
// real attendant, real production voice and the free fallback voice). Scores only.
const url = process.env.VOICE_EVAL_URL || "https://zevanory.api.br/api/internal/voice-eval/run";
const token = process.env.CERTIFICATION_E2E_TOKEN || "";
if (token.length < 32) { console.log("::error title=VOICE_EVAL::token_unavailable"); process.exit(1); }
const r = await fetch(url, { method: "POST", headers: { "x-backup-token": token }, signal: AbortSignal.timeout(280000) });
const rep = await r.json().catch(() => ({ ok: false, failures: ["http_" + r.status] }));
const samples = (rep.samples || []).map((s) => ({ tag: s.tag, ok: s.ok, werIn: s.werIn, werOut: s.werOut, answer: s.answer?.score, provider: s.steps?.answerAudio?.provider, error: s.error }));
console.log("::notice title=VOICE_EVAL::" + JSON.stringify({ http: r.status, ok: rep.ok, scorePct: rep.scorePct, samples, fallback: rep.fallback, keySources: rep.keySources, failures: rep.failures }));
if (!rep.ok) { console.log("::error title=VOICE_EVAL::" + (rep.failures || []).join(", ").slice(0, 400)); process.exit(1); }
