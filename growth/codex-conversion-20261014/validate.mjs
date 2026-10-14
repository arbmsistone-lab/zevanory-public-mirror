import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STAGES = ["discovery", "content", "free_material", "interest", "product_page", "checkout_intent", "checkout"];
const SCORE_KEYS = ["impact", "evidence", "ease", "safety", "zero_cost"];
const FORBIDDEN = /\b(?:lucro garantido|renda garantida|faturamento garantido|resultado garantido|vendas garantidas|vai vender mais|conversão garantida|abandono da zevanory é|taxa de conversão da zevanory é)\b/i;
const SENSITIVE_KEY = /^(?:email|phone|telefone|cpf|cnpj|name|nome|ip|address|endereco|password|token|secret|authorization|api_key|session_id|order_id)$/i;
const assert = (ok, message) => { if (!ok) throw new Error(message); };

function rejectSensitiveKeys(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitiveKeys(item, path + "[" + index + "]"));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(!SENSITIVE_KEY.test(key), "sensitive_key:" + path + "." + key);
    rejectSensitiveKeys(child, path + "." + key);
  }
}

function walkStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach(item => walkStrings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach(item => walkStrings(item, out));
  return out;
}

export function validateC4({ sources, journey, plan }) {
  for (const value of [sources, journey, plan]) {
    assert(value?.schema_version === 1, "schema_version");
    rejectSensitiveKeys(value);
    assert(!FORBIDDEN.test(walkStrings(value).join("\n")), "forbidden_claim");
  }

  assert(sources.metadata?.canonical_sha === "c3717aeb325e7acc6108177426ca420e565bb575", "canonical_sha");
  assert(sources.metadata?.contains_personal_data === false, "sources_personal_data");
  assert(sources.metadata?.publication_allowed === false, "sources_publication");
  assert(Array.isArray(sources.sources) && sources.sources.length >= 10, "sources_minimum");
  const sourceIds = new Set();
  for (const source of sources.sources) {
    assert(/^[a-z0-9-]{3,64}$/.test(source.id || ""), "source_id");
    assert(!sourceIds.has(source.id), "source_duplicate:" + source.id);
    sourceIds.add(source.id);
    const url = new URL(source.url);
    assert(url.protocol === "https:", "source_https:" + source.id);
    assert(Array.isArray(source.supports) && source.supports.length > 0, "source_supports:" + source.id);
    if (source.kind === "external_research") assert(/não mede a ZEVANORY/i.test(source.scope || ""), "external_scope:" + source.id);
  }

  assert(journey.metadata?.contains_personal_data === false, "journey_personal_data");
  assert(journey.metadata?.purchases_performed === 0, "purchases_performed");
  assert(journey.metadata?.forms_submitted === 0, "forms_submitted");
  assert(journey.metadata?.admin_metrics_accessed === false, "admin_metrics");
  assert(Array.isArray(journey.stages) && journey.stages.length === STAGES.length, "seven_stages");
  assert(journey.stages.map(stage => stage.id).join(",") === STAGES.join(","), "stage_order");
  for (const stage of journey.stages) {
    assert(stage.actual === null, "actual_must_be_null:" + stage.id);
    assert(Array.isArray(stage.evidence) && stage.evidence.length > 0, "stage_evidence:" + stage.id);
    for (const id of stage.evidence) assert(sourceIds.has(id), "unknown_evidence:" + stage.id + ":" + id);
    assert(Array.isArray(stage.available_aggregate_metrics), "aggregate_metrics:" + stage.id);
    assert(Array.isArray(stage.gaps) && stage.gaps.length > 0, "stage_gaps:" + stage.id);
  }
  for (const item of journey.conclusions || []) for (const id of item.evidence || []) assert(sourceIds.has(id), "unknown_conclusion_evidence:" + id);

  const m = plan.metadata || {};
  for (const flag of ["publication_allowed", "merge_allowed", "deploy_allowed", "paid_media_allowed", "financial_tests_allowed", "purchases_allowed", "personal_data_allowed"]) {
    assert(m[flag] === false, "safety_flag:" + flag);
  }
  assert(m.additional_cost_brl === 0, "additional_cost");
  assert(Array.isArray(plan.opportunities) && plan.opportunities.length >= 5, "opportunities_minimum");
  const ranked = [...plan.opportunities].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  assert(ranked.map(x => x.id).join(",") === plan.opportunities.map(x => x.id).join(","), "opportunity_order");
  for (let i = 0; i < plan.opportunities.length; i++) {
    const item = plan.opportunities[i];
    assert(item.rank === i + 1, "opportunity_rank:" + item.id);
    assert(SCORE_KEYS.every(key => Number.isInteger(item.score?.[key]) && item.score[key] >= 0 && item.score[key] <= 3), "opportunity_score:" + item.id);
    assert(item.total === SCORE_KEYS.reduce((sum, key) => sum + item.score[key], 0), "opportunity_total:" + item.id);
    for (const id of item.evidence || []) assert(sourceIds.has(id), "unknown_opportunity_evidence:" + item.id + ":" + id);
  }

  assert(Array.isArray(plan.experiments) && plan.experiments.length === 3, "three_experiments");
  const experimentIds = new Set();
  for (let i = 0; i < plan.experiments.length; i++) {
    const exp = plan.experiments[i];
    assert(!experimentIds.has(exp.id), "experiment_duplicate:" + exp.id);
    experimentIds.add(exp.id);
    assert(exp.priority === i + 1, "experiment_priority:" + exp.id);
    assert(exp.status === "proposal_only", "experiment_status:" + exp.id);
    assert(exp.implementation_owner === "Claude" && exp.codex_implementation === false, "implementation_boundary:" + exp.id);
    assert(exp.owner_approval_required === true, "owner_approval:" + exp.id);
    assert(exp.baseline?.value === null && typeof exp.baseline?.reason === "string", "baseline_null:" + exp.id);
    assert(exp.estimated_cost_brl === 0, "experiment_cost:" + exp.id);
    assert(exp.merge_allowed === false && exp.deploy_allowed === false, "experiment_release:" + exp.id);
    assert(typeof exp.hypothesis === "string" && exp.hypothesis.length >= 80, "experiment_hypothesis:" + exp.id);
    assert(typeof exp.primary_indicator?.formula === "string", "primary_indicator:" + exp.id);
    assert(typeof exp.decision_rule?.success === "string" && typeof exp.decision_rule?.inconclusive === "string" && typeof exp.decision_rule?.failure === "string", "decision_rule:" + exp.id);
    assert(Array.isArray(exp.stop_conditions) && exp.stop_conditions.length >= 4, "stop_conditions:" + exp.id);
    for (const id of exp.evidence || []) assert(sourceIds.has(id), "unknown_experiment_evidence:" + exp.id + ":" + id);
  }

  assert(plan.operational_handoff?.owner === "Claude", "handoff_owner");
  assert(plan.operational_handoff?.status === "not_sent_by_code", "handoff_status");
  assert((plan.operational_handoff?.prohibited || []).includes("alterar checkout neste PR"), "handoff_checkout_boundary");

  return { ok: true, sources: sourceIds.size, stages: journey.stages.length, opportunities: plan.opportunities.length, experiments: plan.experiments.length, actual_metrics_used: 0, publication_allowed: false };
}

export async function loadC4(base = new URL(".", import.meta.url)) {
  const [sources, journey, plan] = await Promise.all([
    readFile(new URL("sources.json", base), "utf8").then(JSON.parse),
    readFile(new URL("journey.json", base), "utf8").then(JSON.parse),
    readFile(new URL("opportunities-and-experiments.json", base), "utf8").then(JSON.parse)
  ]);
  return { sources, journey, plan };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.stdout.write(JSON.stringify(validateC4(await loadC4())) + "\n");
}
