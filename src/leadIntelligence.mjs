const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));

export function identityReadiness(input={}){
  const required=['contact_ref','channel','consent_basis'];
  const missing=required.filter(key=>!String(input[key]??'').trim());
  return Object.freeze({ready:missing.length===0,missing:Object.freeze(missing)});
}

export function enrichmentReadiness(input={}){
  const facts=input.facts&&typeof input.facts==='object'?input.facts:{};
  const verified=Object.entries(facts).filter(([,v])=>v&&typeof v==='object'&&v.verified===true&&v.value!==undefined);
  return Object.freeze({ready:verified.length>0,verified_facts:verified.length,total_facts:Object.keys(facts).length});
}

export function scoreIcpFit(input={}){
  const signals=[
    ['segment_fit',0.30],['problem_fit',0.30],['digital_sales_fit',0.20],['operational_pain',0.20],
  ];
  let weighted=0,observedWeight=0;
  for(const [key,weight] of signals){const raw=input[key];if(raw===null||raw===undefined)continue;weighted+=clamp(raw)*weight;observedWeight+=weight;}
  const score=observedWeight>0?weighted/observedWeight:null;
  return Object.freeze({score,confidence:observedWeight,complete:observedWeight>=0.999,missing:Object.freeze(signals.filter(([k])=>input[k]===null||input[k]===undefined).map(([k])=>k))});
}

export function scoreLead(input={}){
  const weights=Object.freeze({icp_score:0.35,intent_score:0.30,engagement_score:0.20,recency_score:0.15});
  let total=0,observed=0;
  for(const [key,weight] of Object.entries(weights)){
    if(input[key]===null||input[key]===undefined) continue;
    total+=clamp(input[key])*weight; observed+=weight;
  }
  const score=observed>0?total/observed:null;
  const band=score===null?'unknown':score>=0.8?'high':score>=0.55?'medium':'low';
  return Object.freeze({score,band,confidence:observed,complete:observed>=0.999});
}

export function prioritizeLead(input={}){
  const lead=scoreLead(input);
  if(lead.score===null) return Object.freeze({priority:'review',rank:null,reason:'insufficient_scoring_evidence',lead});
  const urgency=clamp(input.urgency_score);
  const responseRisk=clamp(input.response_delay_risk);
  const rank=clamp((lead.score*0.7)+(urgency*0.2)+(responseRisk*0.1));
  return Object.freeze({priority:rank>=0.8?'p1':rank>=0.6?'p2':rank>=0.4?'p3':'p4',rank,reason:'evidence_weighted_priority',lead});
}

export function discoveryGaps(input={}){
  const required=['problem','desired_outcome','decision_process','timeline','budget_context','current_process'];
  const missing=required.filter(key=>!String(input[key]??'').trim());
  return Object.freeze({complete:missing.length===0,missing:Object.freeze(missing),observed:required.length-missing.length,total:required.length});
}

export function qualificationDecision(input={}){
  const discovery=discoveryGaps(input);
  const icp=scoreIcpFit(input.icp||{});
  const disqualified=Array.isArray(input.disqualifiers)?input.disqualifiers.filter(Boolean):[];
  if(disqualified.length) return Object.freeze({qualified:false,state:'disqualified',reason:'explicit_disqualifier',disqualifiers:Object.freeze(disqualified),discovery,icp});
  if(!discovery.complete||!icp.complete) return Object.freeze({qualified:false,state:'needs_discovery',reason:'insufficient_verified_facts',discovery,icp});
  const qualified=icp.score>=0.6 && input.problem_confirmed===true && input.next_step_consent===true;
  return Object.freeze({qualified,state:qualified?'qualified':'not_qualified',reason:qualified?'evidence_threshold_met':'qualification_threshold_not_met',discovery,icp});
}
