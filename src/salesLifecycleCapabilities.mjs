import { SALES_LIFECYCLE_CANONICAL_V2 } from './salesLifecycleV2.mjs';

export const SALES_LIFECYCLE_CAPABILITIES=Object.freeze({
  market:Object.freeze({owner:'marketParameters.mjs',capability:'market_evidence_and_parameters'}),
  icp:Object.freeze({owner:'leadIntelligence.mjs',capability:'verified_icp_fit'}),
  acquisition:Object.freeze({owner:'channelAdapters.mjs',capability:'multichannel_acquisition'}),
  capture:Object.freeze({owner:'publicEvent.mjs',capability:'canonical_lead_capture'}),
  identity:Object.freeze({owner:'leadIntelligence.mjs',capability:'contact_identity_readiness'}),
  enrichment:Object.freeze({owner:'leadIntelligence.mjs',capability:'verified_fact_enrichment'}),
  scoring:Object.freeze({owner:'leadIntelligence.mjs',capability:'evidence_weighted_scoring'}),
  prioritization:Object.freeze({owner:'leadIntelligence.mjs',capability:'evidence_weighted_priority'}),
  first_response:Object.freeze({owner:'salesPipeline.mjs',capability:'speed_to_lead_scheduler'}),
  discovery:Object.freeze({owner:'conversationLifecycle.mjs',capability:'discovery_gap_plan'}),
  qualification:Object.freeze({owner:'leadIntelligence.mjs',capability:'verified_qualification'}),
  nurturing:Object.freeze({owner:'conversationLifecycle.mjs',capability:'bounded_nurturing'}),
  objection:Object.freeze({owner:'conversationLifecycle.mjs',capability:'objection_policy'}),
  offer:Object.freeze({owner:'offerCatalog.mjs',capability:'canonical_offer'}),
  negotiation:Object.freeze({owner:'conversationLifecycle.mjs',capability:'price_guardrails'}),
  checkout:Object.freeze({owner:'order.mjs',capability:'idempotent_checkout'}),
  abandonment_recovery:Object.freeze({owner:'conversationLifecycle.mjs',capability:'bounded_checkout_recovery'}),
  payment:Object.freeze({owner:'paymentProviders.mjs',capability:'provider_payment'}),
  reconciliation:Object.freeze({owner:'mercadopago.mjs|asaas.mjs',capability:'provider_truth_reconciliation'}),
  fulfillment:Object.freeze({owner:'digitalFulfillment.mjs',capability:'payment_gated_fulfillment'}),
  onboarding:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'customer_onboarding'}),
  support:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'support_priority'}),
  adoption:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'adoption_health'}),
  satisfaction:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'satisfaction_health'}),
  retention:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'retention_intervention'}),
  repurchase:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'repurchase_next_action'}),
  upsell:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'upsell_eligibility'}),
  cross_sell:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'cross_sell_eligibility'}),
  referral:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'referral_next_action'}),
  win_back:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'win_back_intervention'}),
  churn:Object.freeze({owner:'customerLifecycleEngine.mjs',capability:'churn_state'}),
  ltv:Object.freeze({owner:'revenueIntelligence.mjs',capability:'evidence_based_ltv'}),
  attribution:Object.freeze({owner:'attributionEngine.mjs',capability:'deterministic_multitouch_attribution'}),
  unit_economics:Object.freeze({owner:'unitEconomics.mjs',capability:'contribution_and_cac'}),
  experiment:Object.freeze({owner:'learningEngine.mjs',capability:'evidence_gated_experiment'}),
  learning:Object.freeze({owner:'learningEngine.mjs',capability:'baseline_gated_learning'}),
  forecast:Object.freeze({owner:'revenueIntelligence.mjs',capability:'baseline_gated_forecast'}),
  next_best_action:Object.freeze({owner:'revenueIntelligence.mjs',capability:'next_best_revenue_action'}),
  scale:Object.freeze({owner:'salesLifecycleV2.mjs',capability:'certification_gated_scale'}),
});

export function assessLifecycleCapabilityCoverage(){
  const keys=Object.keys(SALES_LIFECYCLE_CAPABILITIES);
  const missing=SALES_LIFECYCLE_CANONICAL_V2.filter(key=>!SALES_LIFECYCLE_CAPABILITIES[key]);
  const extra=keys.filter(key=>!SALES_LIFECYCLE_CANONICAL_V2.includes(key));
  const invalid=keys.filter(key=>!String(SALES_LIFECYCLE_CAPABILITIES[key]?.owner||'').trim()||!String(SALES_LIFECYCLE_CAPABILITIES[key]?.capability||'').trim());
  return Object.freeze({complete:missing.length===0&&extra.length===0&&invalid.length===0,total:keys.length,missing:Object.freeze(missing),extra:Object.freeze(extra),invalid:Object.freeze(invalid)});
}
