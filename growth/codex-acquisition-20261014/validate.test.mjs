import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePlan, rankOpportunities } from "./validate.mjs";

const source = new URL("./opportunities.json", import.meta.url);
const load = async () => JSON.parse(await readFile(source, "utf8"));

test("the national acquisition plan is valid and ranks all five opportunities", async () => {
  const plan = await load();
  const result = validatePlan(plan);
  assert.equal(result.ok, true);
  assert.equal(result.products, 5);
  assert.equal(result.sources >= 4, true);
  assert.deepEqual(result.priority_order, rankOpportunities(plan.opportunities));
});

test("unknown evidence fails closed", async () => {
  const plan = await load();
  plan.opportunities[0].evidence[0] = "fonte-inexistente";
  assert.throws(() => validatePlan(plan), /opportunity_unknown_source/);
});

test("financial promises fail closed", async () => {
  const plan = await load();
  plan.opportunities[0].claims = "Lucro garantido para todos.";
  assert.throws(() => validatePlan(plan), /forbidden_claim/);
});

test("campaigns incompatible with the existing funnel fail closed", async () => {
  const plan = await load();
  plan.opportunities[0].utm.campaign = "Campanha com espaços e mais de quarenta e oito caracteres para quebrar";
  assert.throws(() => validatePlan(plan), /utm_campaign/);
});

test("secret-like fields are rejected anywhere in the plan", async () => {
  const plan = await load();
  plan.metadata.token = "never-store-secrets";
  assert.throws(() => validatePlan(plan), /sensitive_key/);
});

test("priority cannot diverge from the transparent score", async () => {
  const plan = await load();
  plan.priority_order.reverse();
  assert.throws(() => validatePlan(plan), /priority_order/);
});

test("Pix and WhatsApp are tied; lexical order is deterministic, not commercial evidence", async () => {
  const plan = await load();
  const result = validatePlan(plan);
  assert.equal(result.scores["fluxo-caixa-diario-pix"], 12);
  assert.equal(result.scores["vendas-whatsapp-follow-up"], 12);
  assert.deepEqual(result.ties.find(item => item.score === 12).ids, [
    "fluxo-caixa-diario-pix",
    "vendas-whatsapp-follow-up"
  ]);
  assert.equal(plan.scoring.tie_breaker, "lexicographic_opportunity_id_for_determinism_only");
});

// The existing #813 CI invokes this file; import the concrete campaign suite
// so the stacked PR obtains cloud evidence without adding or changing workflows.
await import("./validate-campaigns.test.mjs");
