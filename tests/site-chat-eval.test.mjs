// P10 offline do chat do site (AVAL Sol 111): >=150 gerais com limite inferior de Wilson 95% >= 0,90 e >=60 críticos
// com 100% de acerto e encaminhamento, cobrindo todas as classes exigidas. Harness: tests/helpers/site-chat-eval.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { runEval, verdict, wilsonLower, loadDataset, REQUIRED_CRITICAL_TAGS } from "./helpers/site-chat-eval.mjs";

test("SE01 conjuntos P10 bem formados: ids únicos, expectativa em todo caso, tamanhos mínimos", () => {
  const g = loadDataset("general").cases, k = loadDataset("critical").cases;
  assert.ok(g.length >= 150, "[SE01.1] " + ("gerais: " + g.length));
  assert.ok(k.length >= 60, "[SE01.2] " + ("críticos: " + k.length));
  const ids = [...g, ...k].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "[SE01.3]");
  for (const c of [...g, ...k]) { assert.ok(c.expect?.kind, "[SE01.4] " + (c.id)); assert.ok(c.q || c.turns?.length, "[SE01.5] " + (c.id)); assert.ok(c.tag, "[SE01.6] " + (c.id)); }
  for (const t of REQUIRED_CRITICAL_TAGS) assert.ok(k.some((c) => c.tag === t), "[SE01.7] " + ("classe crítica ausente: " + t));
  assert.ok(Math.abs(wilsonLower(143, 150) - 0.9067) < 0.001, "[SE01.8] Wilson conferido");
});

test("SE02 P10: gerais com Wilson 95% >= 0,90 e críticos 100% (código real, fakes locais)", async () => {
  const log = console.log;
  console.log = () => {};
  let out;
  try { out = await runEval(); } finally { console.log = log; }
  assert.deepEqual(out.critical.failures.map((f) => `${f.id} ${f.tag}: ${f.reasons.join(",")}`), [], "[SE02.1] crítico falhou");
  assert.ok(out.general.wilson_lower_95 >= 0.9, `[SE02.2] Wilson ${out.general.wilson_lower_95}; falhas: ${JSON.stringify(out.general.failures.slice(0, 5))}`);
  assert.equal(verdict(out), true, "[SE02.3]");
});
