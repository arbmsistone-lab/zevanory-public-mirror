import test from "node:test";
import assert from "node:assert/strict";
import { BATTERY, scoreAnswer } from "../scripts/audit/support-eval.mjs";
import { converse } from "../worker/whatsapp-conversation.mjs";

test("the grounded fallback alone already answers the battery safely", async () => {
  const scores = [];
  for (const item of BATTERY) scores.push(scoreAnswer(item, await converse({ question: item.q, salesOpen: true })));
  assert.ok(scores.every((s) => s.checks.safe), JSON.stringify(scores.filter((s) => !s.checks.safe)));
  const pct = scores.reduce((a, s) => a + s.score, 0) / scores.length;
  assert.ok(pct >= 0.8, "grounded baseline " + pct);
});

test("an invented price or a refund promise fails the score", () => {
  const item = { q: "x", expect: [], forbid: [/reembolso (j[aá] )?(foi )?(aprovado|feito)/i] };
  assert.equal(scoreAnswer(item, { body: "Custa R$ 99,00" }).checks.safe, false);
  assert.equal(scoreAnswer(item, { body: "Seu reembolso foi aprovado." }).checks.noForbidden, false);
});

import { runSupportEvalIfDue } from "../worker/support-eval.mjs";
test("worker runner uses the AI binding weekly and records which runtime answered", async () => {
  const m = new Map(); const kv = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
  const ai = { run: async () => ({ response: "Olá! Posso te ajudar a escolher o material certo. Qual é o seu negócio?" }) };
  const r = await runSupportEvalIfDue({ ZEVANORY_PRIVATE_ARTIFACTS: kv, AI: ai });
  assert.equal(r.ran, true);
  const saved = JSON.parse(m.get("zpc:support:v1:eval"));
  assert.equal(saved.runtime, "worker-ai-binding"); assert.ok(saved.aiAnsweredPct > 0);
  assert.equal((await runSupportEvalIfDue({ ZEVANORY_PRIVATE_ARTIFACTS: kv, AI: ai })).ran, false, "weekly");
});
