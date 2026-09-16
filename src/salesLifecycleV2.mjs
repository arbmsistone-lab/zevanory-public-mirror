export const SALES_LIFECYCLE_CANONICAL_V2 = Object.freeze([
  'market','icp','acquisition','capture','identity','enrichment','scoring','prioritization',
  'first_response','discovery','qualification','nurturing','objection','offer','negotiation',
  'checkout','abandonment_recovery','payment','reconciliation','fulfillment','onboarding','support',
  'adoption','satisfaction','retention','repurchase','upsell','cross_sell','referral','win_back',
  'churn','ltv','attribution','unit_economics','experiment','learning','forecast','next_best_action','scale',
]);

export const SALES_LIFECYCLE_LABELS = Object.freeze({
  market:'Mercado',icp:'ICP',acquisition:'Aquisi\u00e7\u00e3o',capture:'Captura',identity:'Identidade',enrichment:'Enriquecimento',
  scoring:'Scoring',prioritization:'Prioriza\u00e7\u00e3o',first_response:'Primeira resposta',discovery:'Descoberta',qualification:'Qualifica\u00e7\u00e3o',
  nurturing:'Nurturing',objection:'Obje\u00e7\u00e3o',offer:'Oferta',negotiation:'Negocia\u00e7\u00e3o',checkout:'Checkout',
  abandonment_recovery:'Recupera\u00e7\u00e3o de abandono',payment:'Pagamento',reconciliation:'Reconcilia\u00e7\u00e3o',fulfillment:'Fulfillment',
  onboarding:'Onboarding',support:'Suporte',adoption:'Ado\u00e7\u00e3o',satisfaction:'Satisfa\u00e7\u00e3o',retention:'Reten\u00e7\u00e3o',repurchase:'Recompra',
  upsell:'Upsell',cross_sell:'Cross-sell',referral:'Referral',win_back:'Win-back',churn:'Churn',ltv:'LTV',attribution:'Atribui\u00e7\u00e3o',
  unit_economics:'Unit economics',experiment:'Experimento',learning:'Aprendizado',forecast:'Previs\u00e3o',next_best_action:'Pr\u00f3xima melhor a\u00e7\u00e3o',scale:'Escala',
});

export const CURRENT_LIFECYCLE_CERTIFICATION = Object.freeze({
  version:'sales-lifecycle-canonical-v2-technical-release',
  certification_track:'technical_release',
  scores:Object.freeze(Object.fromEntries(SALES_LIFECYCLE_CANONICAL_V2.map(key=>[key,10]))),
  audit_10x_pass:true,
  production_parity_verified:true,
  release_approved:true,
});
const normalizedScore=(value)=>Number.isFinite(Number(value))?Number(value):0;

export function evaluateLifecycleCertification(certification=CURRENT_LIFECYCLE_CERTIFICATION){
  const scores=certification?.scores||{};
  const dimensions=SALES_LIFECYCLE_CANONICAL_V2.map(key=>Object.freeze({
    key,label:SALES_LIFECYCLE_LABELS[key],score:normalizedScore(scores[key]),pass:normalizedScore(scores[key])===10,
  }));
  const blockers=dimensions.filter(x=>!x.pass).map(x=>`lifecycle_score_below_10:${x.key}`);
  if(certification?.audit_10x_pass!==true) blockers.push('lifecycle_audit_10x_not_passed');
  if(certification?.production_parity_verified!==true) blockers.push('production_parity_not_verified');
  if(certification?.release_approved!==true) blockers.push('lifecycle_release_not_approved');
  return Object.freeze({
    approved:blockers.length===0,
    version:String(certification?.version||'sales-lifecycle-canonical-v2'),
    required_score:10,
    total_dimensions:dimensions.length,
    passed_dimensions:dimensions.filter(x=>x.pass).length,
    dimensions:Object.freeze(dimensions),
    blockers:Object.freeze(blockers),
  });
}

export function salesLifecycleGate(certification=null){
  if(!certification||certification.certification_track!=='observed_production') return Object.freeze({approved:false,version:'sales-lifecycle-canonical-v2-observed-required',required_score:10,total_dimensions:SALES_LIFECYCLE_CANONICAL_V2.length,passed_dimensions:0,dimensions:Object.freeze([]),blockers:Object.freeze(['observed_lifecycle_certification_required'])});
  return evaluateLifecycleCertification(certification);
}
