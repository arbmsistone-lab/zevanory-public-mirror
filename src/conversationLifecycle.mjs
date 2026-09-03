const clean=(value,max=500)=>String(value??'').trim().slice(0,max);

export function buildDiscoveryPlan(input={}){
  const fields=[
    ['problem','Qual problema voce quer resolver?'],['desired_outcome','Qual resultado voce espera?'],
    ['current_process','Como isso e feito hoje?'],['timeline','Existe prazo para resolver?'],
    ['decision_process','Quem participa da decisao?'],['budget_context','Existe faixa de investimento definida?'],
  ];
  const questions=fields.filter(([key])=>!clean(input[key])).map(([key,question])=>Object.freeze({key,question}));
  return Object.freeze({complete:questions.length===0,questions:Object.freeze(questions),next_question:questions[0]||null});
}

export function nurturingPlan({engagement='warm',touchpoints=0,opted_out=false,last_contact_at=null}={}){
  if(opted_out) return Object.freeze({action:'stop',reason:'opt_out',due_at:null});
  const n=Math.max(0,Math.trunc(Number(touchpoints)||0));
  if(n>=8) return Object.freeze({action:'recycle',reason:'touchpoint_ceiling',due_at:null});
  const delayHours=engagement==='hot'?24:engagement==='cold'?120:72;
  const base=last_contact_at?new Date(last_contact_at):new Date();
  if(Number.isNaN(base.getTime())) throw new Error('invalid_last_contact_at');
  return Object.freeze({action:'nurture',touchpoint_number:n+1,due_at:new Date(base.getTime()+delayHours*3600000).toISOString(),delay_hours:delayHours});
}

const OBJECTION_POLICIES=Object.freeze({
  price:Object.freeze({action:'clarify_value_and_constraints',requires_discount:false}),
  timing:Object.freeze({action:'clarify_timeline_and_revisit_date',requires_discount:false}),
  trust:Object.freeze({action:'provide_verified_evidence',requires_discount:false}),
  fit:Object.freeze({action:'revisit_requirements',requires_discount:false}),
  authority:Object.freeze({action:'map_decision_process',requires_discount:false}),
  competitor:Object.freeze({action:'compare_verified_requirements',requires_discount:false}),
});

export function objectionResponsePolicy({category,evidence_available=false}={}){
  const key=clean(category,40).toLowerCase(); const policy=OBJECTION_POLICIES[key];
  if(!policy) return Object.freeze({action:'review',reason:'unknown_objection',category:key||null});
  if((key==='trust'||key==='competitor')&&!evidence_available) return Object.freeze({action:'collect_evidence',reason:'verified_evidence_required',category:key});
  return Object.freeze({...policy,category:key,reason:'known_objection_policy'});
}

export function negotiationDecision({list_price_brl,proposed_price_brl,min_price_brl,discount_approval=false}={}){
  const list=Number(list_price_brl),proposed=Number(proposed_price_brl),floor=Number(min_price_brl);
  if(![list,proposed,floor].every(Number.isFinite)||list<=0||floor<=0||floor>list) return Object.freeze({allowed:false,reason:'invalid_price_guardrails'});
  if(proposed>list) return Object.freeze({allowed:false,reason:'proposed_above_list'});
  if(proposed<floor&&!discount_approval) return Object.freeze({allowed:false,reason:'human_discount_approval_required'});
  if(proposed<floor&&discount_approval!==true) return Object.freeze({allowed:false,reason:'approval_invalid'});
  return Object.freeze({allowed:proposed>=floor||discount_approval===true,reason:proposed>=floor?'within_guardrails':'approved_exception',discount_pct:(list-proposed)/list});
}

export function abandonmentRecoveryPlan({attempts=0,opted_out=false,checkout_status='abandoned',last_event_at=null}={}){
  if(opted_out) return Object.freeze({action:'stop',reason:'opt_out',due_at:null});
  if(checkout_status!=='abandoned') return Object.freeze({action:'none',reason:'checkout_not_abandoned',due_at:null});
  const count=Math.max(0,Math.trunc(Number(attempts)||0));
  const scheduleHours=[1,24,72];
  if(count>=scheduleHours.length) return Object.freeze({action:'stop',reason:'recovery_touchpoint_ceiling',due_at:null});
  const base=last_event_at?new Date(last_event_at):new Date();
  if(Number.isNaN(base.getTime())) throw new Error('invalid_last_event_at');
  const delay=scheduleHours[count];
  return Object.freeze({action:'recover_checkout',attempt:count+1,delay_hours:delay,due_at:new Date(base.getTime()+delay*3600000).toISOString()});
}
