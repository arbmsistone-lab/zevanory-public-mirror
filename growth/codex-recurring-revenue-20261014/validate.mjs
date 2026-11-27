import fs from "node:fs/promises";
const here = new URL("./", import.meta.url);
const readJson = async name => JSON.parse(await fs.readFile(new URL(name, here), "utf8"));
const assert = (ok, code) => { if (!ok) throw new Error(code); };
const forbidden = /garantid[oa]|convers[aã]o comprovada|receita comprovada|lucro garantido|clientes comprovados/i;
const sensitive = /email|phone|telefone|cpf|cnpj|address|endereco|password|token|secret|api_key|session_id|order_id/i;

export async function loadC5() {
  return { sources: await readJson("sources.json"), plan: await readJson("opportunities.json") };
}

export function validateC5({sources, plan}) {
  assert(sources.metadata.contains_personal_data === false, "personal_data_flag");
  assert(sources.metadata.publication_allowed === false, "publication_flag");
  assert(Array.isArray(sources.sources) && sources.sources.length >= 12, "source_count");
  const ids = new Set(sources.sources.map(s => s.id));
  assert(ids.size === sources.sources.length, "duplicate_source");
  for (const source of sources.sources) {
    assert(/^https:\/\//.test(source.url), "source_url");
    assert(source.limitation && source.limitation.length >= 20, "source_limitation");
  }

  for (const [key,value] of Object.entries(plan.metadata)) {
    if (typeof value === "boolean" && /accessed|known|used|allowed/.test(key)) assert(value === false, `metadata_flag:${key}`);
  }
  assert(plan.opportunities.length === 3, "three_opportunities");
  assert(plan.opportunities.filter(o => o.id === plan.recommendation.opportunity_id).length === 1, "single_recommendation");
  assert(plan.opportunities.filter(o => o.status === "existing_offer_to_validate").length === 1, "one_existing_offer");
  const sorted = [...plan.opportunities].sort((a,b) => b.total-a.total || a.id.localeCompare(b.id));
  assert(sorted.every((o,i) => o.id === plan.opportunities[i].id && o.rank === i+1), "ranking_order");

  for (const o of plan.opportunities) {
    assert(Object.values(o.scores).every(n => Number.isInteger(n) && n >= 1 && n <= 5), "score_range");
    assert(Object.values(o.scores).reduce((a,b)=>a+b,0) === o.total, "score_total");
    assert(o.evidence.every(id => ids.has(id)), "unknown_evidence");
    assert(o.price_status.includes("unvalidated") || o.price_status.includes("hypothesis"), "price_not_hypothesis");
    assert(o.delivery_cost_estimate.status === "not_quantified", "fabricated_cost");
    assert(Array.isArray(o.delivery_cost_estimate.drivers) && o.delivery_cost_estimate.drivers.length >= 3, "cost_drivers");
  }

  const serialized = JSON.stringify(plan);
  assert(!forbidden.test(serialized), "forbidden_claim");
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") {
      for (const [key,val] of Object.entries(value)) {
        assert(!sensitive.test(key), `sensitive_key:${key}`);
        walk(val);
      }
    }
  };
  walk(plan);
  const test = plan.recommendation.demand_test_without_charge;
  assert(test.status === "proposal_only_owner_approval_required", "test_status");
  assert(test.forbidden.includes("charge") && test.forbidden.includes("production publication"), "test_guardrails");
  assert(test.minimum_exposure === 200 && test.maximum_days === 28, "test_bounds");
  return {
    ok: true,
    sources: sources.sources.length,
    opportunities: plan.opportunities.length,
    recommendation: plan.recommendation.opportunity_id,
    commercial_metrics_accessed: false,
    publication_allowed: false
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\","/")}`) {
  console.log(JSON.stringify(validateC5(await loadC5())));
}
