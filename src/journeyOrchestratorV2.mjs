const clampInt=(v,min,max)=>Math.max(min,Math.min(max,Math.trunc(Number(v)||0)));
export const JOURNEY_V2_POLICY=Object.freeze({max_touches_24h:2,max_touches_7d:5,min_gap_minutes:120,terminal:['paid','delivered','refunded','unqualified','lost']});

export function journeyEligibility(input={},policy=JOURNEY_V2_POLICY){
  const blockers=[]; const stage=String(input.stage||'new');
  if(policy.terminal.includes(stage))blockers.push('terminal_stage');
  if(input.consent_allowed!==true)blockers.push('consent_not_allowed');
  if(input.suppressed===true)blockers.push('suppressed');
  if(clampInt(input.touches_24h,0,999)>=policy.max_touches_24h)blockers.push('daily_frequency_cap');
  if(clampInt(input.touches_7d,0,999)>=policy.max_touches_7d)blockers.push('weekly_frequency_cap');
  if(Number(input.minutes_since_last_touch||999999)<policy.min_gap_minutes)blockers.push('minimum_gap_not_met');
  return Object.freeze({eligible:blockers.length===0,blockers:Object.freeze(blockers)});
}
export function nextJourneyStep(input={}){
  const eligibility=journeyEligibility(input); if(!eligibility.eligible)return Object.freeze({action:'none',eligibility});
  const stage=String(input.stage||'new'),preferred=String(input.preferred_channel||'').toLowerCase();
  const channel=preferred||(['new','contacted'].includes(stage)?'whatsapp':'email');
  const action=stage==='new'?'first_response':stage==='contacted'?'discovery_follow_up':stage==='qualified'?'offer_follow_up':stage==='offer_sent'?'checkout_nudge':'relationship_follow_up';
  return Object.freeze({action,channel,eligibility,requires_sales_gate:true,commercial_unlock:false});
}
