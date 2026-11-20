import test from "node:test";
import assert from "node:assert/strict";
import { loadC5, validateC5 } from "./validate.mjs";
const fresh = async () => structuredClone(await loadC5());

test("C5 has verifiable sources, exactly three opportunities and one recommendation", async () => {
  assert.deepEqual(validateC5(await fresh()), {
    ok: true,
    sources: 14,
    opportunities: 3,
    recommendation: "conteudo-pronto-setorial",
    commercial_metrics_accessed: false,
    publication_allowed: false
  });
});
test("commercial metrics cannot be claimed as accessed", async () => {
  const x=await fresh(); x.plan.metadata.commercial_metrics_accessed=true;
  assert.throws(()=>validateC5(x),/metadata_flag/);
});
test("willingness to pay cannot be marked known", async () => {
  const x=await fresh(); x.plan.metadata.actual_willingness_to_pay_known=true;
  assert.throws(()=>validateC5(x),/metadata_flag/);
});
test("every source must declare a limitation", async () => {
  const x=await fresh(); x.sources.sources[0].limitation="";
  assert.throws(()=>validateC5(x),/source_limitation/);
});
test("unknown evidence fails closed", async () => {
  const x=await fresh(); x.plan.opportunities[0].evidence.push("unknown");
  assert.throws(()=>validateC5(x),/unknown_evidence/);
});
test("ranking is derived from transparent totals", async () => {
  const x=await fresh(); x.plan.opportunities[0].total=99;
  assert.throws(()=>validateC5(x),/score_total/);
});
test("ranking order cannot be rewritten", async () => {
  const x=await fresh(); x.plan.opportunities.reverse();
  assert.throws(()=>validateC5(x),/ranking_order/);
});
test("only three opportunities are allowed", async () => {
  const x=await fresh(); x.plan.opportunities.push(structuredClone(x.plan.opportunities[0]));
  assert.throws(()=>validateC5(x),/three_opportunities/);
});
test("only one existing offer is selected for validation", async () => {
  const x=await fresh(); x.plan.opportunities[1].status="existing_offer_to_validate";
  assert.throws(()=>validateC5(x),/one_existing_offer/);
});
test("costs cannot be fabricated", async () => {
  const x=await fresh(); x.plan.opportunities[0].delivery_cost_estimate.status="R$ 10";
  assert.throws(()=>validateC5(x),/fabricated_cost/);
});
test("commercial guarantees fail closed", async () => {
  const x=await fresh(); x.plan.opportunities[0].differentiation="lucro garantido";
  assert.throws(()=>validateC5(x),/forbidden_claim/);
});
test("demand test remains proposal-only and bounded", async () => {
  const x=await fresh(); x.plan.recommendation.demand_test_without_charge.status="live";
  assert.throws(()=>validateC5(x),/test_status/);
});
test("personal-data shaped fields fail closed", async () => {
  const x=await fresh(); x.plan.metadata.email="person@example.com";
  assert.throws(()=>validateC5(x),/sensitive_key/);
});
