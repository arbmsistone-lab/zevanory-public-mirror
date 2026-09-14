const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const finiteOrNull=(v)=>v===null||v===undefined||String(v).trim()===''?null:(Number.isFinite(Number(v))?Number(v):null);
const normalizeOrg=(v)=>String(v||'').trim().toLowerCase();

export const MARKET_INTELLIGENCE_POLICY=Object.freeze({
  version:'market-intelligence-v1',
  min_verified_sources:3,
  min_independent_organizations:3,
  invest_score:0.80,
  test_score:0.62,
  discard_score:0.38,
  max_conflict_ratio_for_invest:0.25,
});

export function evidenceReadiness(evidence=[],policy=MARKET_INTELLIGENCE_POLICY){
  const valid=(Array.isArray(evidence)?evidence:[]).filter(x=>x&&x.verified===true&&String(x.source_url||'').startsWith('https://'));
  const organizations=new Set(valid.map(x=>normalizeOrg(x.organization||x.source)).filter(Boolean));
  const conflicts=valid.filter(x=>x.conflict===true).length;
  const conflictRatio=valid.length?conflicts/valid.length:0;
  return Object.freeze({
    ready:valid.length>=policy.min_verified_sources&&organizations.size>=policy.min_independent_organizations,
    verified_sources:valid.length,
    independent_organizations:organizations.size,
    conflict_ratio:conflictRatio,
  });
}
export function opportunityScore(input={}){
  const dimensions={
    demand:finiteOrNull(input.demand), trend:finiteOrNull(input.trend),
    competition:finiteOrNull(input.competition), margin:finiteOrNull(input.margin),
    strategic_fit:finiteOrNull(input.strategic_fit), execution_fit:finiteOrNull(input.execution_fit),
  };
  const weighted=[
    ['demand',0.24,false],['trend',0.14,false],['competition',0.14,true],
    ['margin',0.22,false],['strategic_fit',0.16,false],['execution_fit',0.10,false],
  ];
  let total=0,observedWeight=0;
  for(const [key,weight,invert] of weighted){
    const raw=dimensions[key]; if(raw===null)continue;
    const value=invert?1-clamp(raw):clamp(raw); total+=value*weight; observedWeight+=weight;
  }
  return Object.freeze({
    score:observedWeight?total/observedWeight:null,
    confidence:observedWeight,
    complete:observedWeight>=0.999,
    dimensions:Object.freeze(dimensions),
    missing:Object.freeze(weighted.filter(([key])=>dimensions[key]===null).map(([key])=>key)),
  });
}

export function decideMarketOpportunity(input={},policy=MARKET_INTELLIGENCE_POLICY){
  const readiness=evidenceReadiness(input.evidence,policy);
  const opportunity=opportunityScore(input);
  if(!readiness.ready)return Object.freeze({decision:'EVIDENCIA_INSUFICIENTE',reason:'minimum_verified_evidence_not_met',readiness,opportunity});
  if(!opportunity.complete)return Object.freeze({decision:'EVIDENCIA_INSUFICIENTE',reason:'opportunity_dimensions_incomplete',readiness,opportunity});
  if(readiness.conflict_ratio>policy.max_conflict_ratio_for_invest&&opportunity.score>=policy.invest_score){
    return Object.freeze({decision:'TESTAR',reason:'conflicting_evidence_requires_controlled_test',readiness,opportunity});
  }
  if(opportunity.score>=policy.invest_score)return Object.freeze({decision:'INVESTIR',reason:'high_evidence_weighted_opportunity',readiness,opportunity});
  if(opportunity.score>=policy.test_score)return Object.freeze({decision:'TESTAR',reason:'promising_but_experiment_required',readiness,opportunity});
  if(opportunity.score<policy.discard_score)return Object.freeze({decision:'DESCARTAR',reason:'evidence_weighted_score_below_floor',readiness,opportunity});
  return Object.freeze({decision:'AGUARDAR',reason:'mixed_evidence_no_clear_action',readiness,opportunity});
}

export function sanitizeEvidence(evidence=[]){
  return Object.freeze((Array.isArray(evidence)?evidence:[]).map(x=>Object.freeze({
    source:String(x?.source||''),organization:String(x?.organization||''),
    source_url:String(x?.source_url||''),observed_at:x?.observed_at||null,
    verified:x?.verified===true,conflict:x?.conflict===true,
    signal:finiteOrNull(x?.signal),kind:String(x?.kind||'market_signal'),
  })));
}

