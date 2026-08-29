import { createHash } from 'node:crypto';

export const DEFAULT_AI_MODEL = 'gemini-3.7-flash';
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function deterministicDecision(input = {}) {
  const stage = String(input.stage || 'new');
  const map = {
    new: 'first_response', contacted: 'qualify', qualified: 'offer',
    offer_sent: 'follow_up', checkout_started: 'follow_up',
  };
  return Object.freeze({
    provider: 'deterministic', model: 'rules-v1', mode: 'deterministic',
    action: map[stage] || 'review', confidence: 1,
    rationale: 'Fail-safe deterministic policy used because AI is unavailable or not required.',
    input_hash: hash(input),
  });
}

export async function askGemini({ input, systemInstruction, apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_AI_MODEL } = {}) {
  if (!apiKey || process.env.AGENT_AI_ENABLED !== 'true') return deterministicDecision(input);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: String(systemInstruction || '') }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input || {}) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  const started = Date.now();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`gemini_http_${response.status}`);
  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';
  let decision;
  try { decision = JSON.parse(text); } catch { throw new Error('gemini_invalid_json'); }
  return Object.freeze({ provider: 'google', model, mode: 'ai_assisted', latency_ms: Date.now() - started, input_hash: hash(input), ...decision });
}
