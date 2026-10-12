import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareRates, evaluateArms, evaluateBeforeAfter, evaluateExperiments } from "../scripts/audit/experiments.mjs";

const registry = JSON.parse(readFileSync(new URL("../data/experiments.json", import.meta.url)));
const now = Date.parse("2026-11-20T12:00:00Z");
const vid = (slot, views, daysAgo) => ({ slot, views, publishedAt: new Date(now - daysAgo * 864e5).toISOString() });

test("no verdict without enough videos per arm", () => {
  const exp = registry.experiments[0];
  const r = evaluateArms(exp, [vid("dica", 500, 5), vid("oferta", 10, 5)], now);
  assert.equal(r.status, "collecting");
});

test("a clear difference with enough data names the winner; noise does not", () => {
  const exp = registry.experiments[0];
  const vids = [];
  for (let i = 0; i < 8; i++) { vids.push(vid("dica", 400 + i * 30, 5 + i)); vids.push(vid("oferta", 20 + i, 5 + i)); vids.push(vid("calc", 100 + i * 5, 5 + i)); }
  const r = evaluateArms(exp, vids, now);
  assert.equal(r.status, "winner"); assert.equal(r.winner, "dica");
  const noisy = [];
  for (let i = 0; i < 8; i++) for (const s of ["dica", "oferta", "calc"]) noisy.push(vid(s, 100 + ((i * 37) % 50), 5 + i));
  assert.equal(evaluateArms(exp, noisy, now).status, "no_difference");
});

test("before/after uses equal windows and a proportion test", () => {
  const exp = registry.experiments[1];
  const daily = {};
  for (let i = 1; i <= 14; i++) { daily[new Date(Date.parse("2026-10-12") - i * 864e5).toISOString().slice(0, 10)] = { views: 50, intents: 1 }; daily[new Date(Date.parse("2026-10-12") + (i - 1) * 864e5).toISOString().slice(0, 10)] = { views: 50, intents: 4 }; }
  const r = evaluateBeforeAfter(exp, daily, now);
  assert.equal(r.status, "winner");
  assert.ok(compareRates(10, 1000, 11, 1000).p > 0.5);
});

test("every registered experiment evaluates with no data and never claims a result", () => {
  const out = evaluateExperiments(registry, {}, Date.parse("2026-10-13T00:00:00Z"));
  assert.equal(out.length, registry.experiments.length);
  for (const e of out) { assert.ok(["collecting", "tracking"].includes(e.status), e.id); assert.ok(e.hypothesis && e.metric && e.verdict); }
});
