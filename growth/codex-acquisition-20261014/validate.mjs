import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PRODUCT_IDS = new Set(["ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo"]);
const CAMPAIGN = /^[a-z0-9_]{1,48}$/;
const LABEL = /^[a-z0-9_-]{1,24}$/;
const FORBIDDEN = /\b(?:lucro garantido|renda garantida|faturamento garantido|resultado garantido|ganhe dinheiro|vendas garantidas)\b/i;
const SECRET_KEY = /^(?:token|secret|password|authorization|api_key|access_key|private_key)$/i;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const isScore = value => Number.isInteger(value) && value >= 0 && value <= 3;
const scoreOf = opportunity => Object.values(opportunity.score).reduce((sum, value) => sum + value, 0);

function rejectSensitiveKeys(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitiveKeys(item, path + "[" + index + "]"));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(!SECRET_KEY.test(key), "sensitive_key:" + path + "." + key);
    rejectSensitiveKeys(child, path + "." + key);
  }
}

export function rankOpportunities(opportunities) {
  return [...opportunities].sort((a, b) => scoreOf(b) - scoreOf(a) || a.id.localeCompare(b.id)).map(item => item.id);
}

export function validatePlan(plan) {
  assert(plan && typeof plan === "object", "plan_required");
  rejectSensitiveKeys(plan);
  assert(plan.schema_version === 1, "schema_version");
  assert(plan.metadata?.market === "BR", "market_must_be_BR");
  assert(plan.metadata?.publication_allowed === false, "publication_must_be_disabled");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(plan.metadata?.as_of || ""), "as_of");

  assert(Array.isArray(plan.sources) && plan.sources.length >= 4, "sources_minimum");
  const sourceIds = new Set();
  for (const source of plan.sources) {
    assert(/^[a-z0-9-]{3,64}$/.test(source.id || ""), "source_id");
    assert(!sourceIds.has(source.id), "source_duplicate:" + source.id);
    sourceIds.add(source.id);
    const url = new URL(source.url);
    assert(url.protocol === "https:", "source_https:" + source.id);
    assert(Array.isArray(source.signals) && source.signals.length > 0, "source_signals:" + source.id);
  }

  assert(Array.isArray(plan.products) && plan.products.length === PRODUCT_IDS.size, "five_products_required");
  assert(new Set(plan.products.map(product => product.id)).size === PRODUCT_IDS.size, "product_duplicate");
  for (const product of plan.products) assert(PRODUCT_IDS.has(product.id), "unknown_product:" + product.id);

  assert(plan.scoring?.tie_breaker === "lexicographic_opportunity_id_for_determinism_only", "tie_breaker");
  assert(Array.isArray(plan.opportunities) && plan.opportunities.length >= 5, "opportunities_minimum");
  const opportunityIds = new Set();
  for (const item of plan.opportunities) {
    assert(/^[a-z0-9-]{3,64}$/.test(item.id || ""), "opportunity_id");
    assert(!opportunityIds.has(item.id), "opportunity_duplicate:" + item.id);
    opportunityIds.add(item.id);
    assert(Array.isArray(item.products) && item.products.length > 0, "opportunity_products:" + item.id);
    item.products.forEach(product => assert(PRODUCT_IDS.has(product), "opportunity_unknown_product:" + item.id));
    assert(Array.isArray(item.evidence) && item.evidence.length >= 2, "opportunity_evidence:" + item.id);
    item.evidence.forEach(source => assert(sourceIds.has(source), "opportunity_unknown_source:" + item.id));
    assert(Array.isArray(item.keywords) && item.keywords.length >= 2, "opportunity_keywords:" + item.id);
    assert(LABEL.test(item.utm?.source || ""), "utm_source:" + item.id);
    assert(LABEL.test(item.utm?.medium || ""), "utm_medium:" + item.id);
    assert(CAMPAIGN.test(item.utm?.campaign || ""), "utm_campaign:" + item.id);
    assert(item.score && Object.keys(item.score).length === 4, "score_dimensions:" + item.id);
    Object.values(item.score).forEach(value => assert(isScore(value), "score_range:" + item.id));
    const text = JSON.stringify(item);
    assert(!FORBIDDEN.test(text), "forbidden_claim:" + item.id);
  }

  assert(JSON.stringify(plan.priority_order) === JSON.stringify(rankOpportunities(plan.opportunities)), "priority_order");
  return {
    ok: true,
    as_of: plan.metadata.as_of,
    market: plan.metadata.market,
    sources: plan.sources.length,
    products: plan.products.length,
    opportunities: plan.opportunities.length,
    priority_order: plan.priority_order,
    scores: Object.fromEntries(plan.opportunities.map(item => [item.id, scoreOf(item)])),
    ties: Object.entries(Object.groupBy(plan.opportunities, scoreOf)).filter(([, items]) => items.length > 1).map(([score, items]) => ({ score: Number(score), ids: items.map(item => item.id).sort() }))
  };
}

async function main() {
  const file = process.argv[2];
  assert(file, "usage: node validate.mjs <opportunities.json>");
  const plan = JSON.parse(await readFile(file, "utf8"));
  process.stdout.write(JSON.stringify(validatePlan(plan), null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(String(error.message || error) + "\n");
    process.exitCode = 1;
  });
}
