import test from "node:test";
import assert from "node:assert/strict";
import { loadC4, validateC4 } from "./validate.mjs";

const fresh = async () => structuredClone(await loadC4());

test("C4 maps seven stages, ranks opportunities and defines exactly three experiments", async () => {
  const input = await fresh();
  assert.deepEqual(validateC4(input), {
    ok: true,
    sources: 15,
    stages: 7,
    opportunities: 6,
    experiments: 3,
    actual_metrics_used: 0,
    publication_allowed: false
  });
});

test("actual conversion metrics cannot be invented", async () => {
  const input = await fresh();
  input.journey.stages[0].actual = { visitors: 1000, conversion: 0 };
  assert.throws(() => validateC4(input), /actual_must_be_null/);
});

test("unknown evidence fails closed", async () => {
  const input = await fresh();
  input.journey.stages[0].evidence = ["fonte-inexistente"];
  assert.throws(() => validateC4(input), /unknown_evidence/);
});

test("generic research must not masquerade as ZEVANORY measurement", async () => {
  const input = await fresh();
  input.sources.sources.find(source => source.id === "baymard-checkout").scope = "mede a ZEVANORY";
  assert.throws(() => validateC4(input), /external_scope/);
});

test("commercial promises fail closed", async () => {
  const input = await fresh();
  input.plan.experiments[0].hypothesis = "Conversão garantida para a ZEVANORY com esta mudança.";
  assert.throws(() => validateC4(input), /forbidden_claim/);
});

test("ranking cannot diverge from the transparent score", async () => {
  const input = await fresh();
  input.plan.opportunities.reverse();
  assert.throws(() => validateC4(input), /opportunity_order/);
});

test("opportunity totals are recomputed", async () => {
  const input = await fresh();
  input.plan.opportunities[0].total = 99;
  assert.throws(() => validateC4(input), /opportunity_total/);
});

test("the package cannot expand beyond three experiments", async () => {
  const input = await fresh();
  input.plan.experiments.push(structuredClone(input.plan.experiments[0]));
  assert.throws(() => validateC4(input), /three_experiments/);
});

test("every experiment starts without a fabricated baseline", async () => {
  const input = await fresh();
  input.plan.experiments[1].baseline.value = 0.12;
  assert.throws(() => validateC4(input), /baseline_null/);
});

test("Codex cannot become the operational implementer", async () => {
  const input = await fresh();
  input.plan.experiments[2].implementation_owner = "Codex";
  assert.throws(() => validateC4(input), /implementation_boundary/);
});

test("paid spend and release flags fail closed", async () => {
  const input = await fresh();
  input.plan.metadata.paid_media_allowed = true;
  assert.throws(() => validateC4(input), /safety_flag:paid_media_allowed/);
});

test("experiments must remain zero-cost and unreleased", async () => {
  const input = await fresh();
  input.plan.experiments[0].estimated_cost_brl = 10;
  assert.throws(() => validateC4(input), /experiment_cost/);
});

test("personal-data shaped fields are rejected", async () => {
  const input = await fresh();
  input.plan.metadata.email = "pessoa@example.com";
  assert.throws(() => validateC4(input), /sensitive_key/);
});
