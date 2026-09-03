export const CUSTOMER_LIFECYCLE_STAGES = Object.freeze([
  'onboarding','support','adoption','satisfaction','retention','repurchase',
  'upsell','cross_sell','referral','win_back','churned'
]);

const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,Number(value)||0));
const daysSince=(date,now=new Date())=>{
  if(!date) return null;
  const parsed=new Date(date); if(Number.isNaN(parsed.getTime())) return null;
  return Math.max(0,(now.getTime()-parsed.getTime())/86400000);
};

export function customerHealth(input={},now=new Date()){
  const adoption=clamp(input.adoption_score);
  const satisfaction=clamp(input.satisfaction_score);
  const supportRisk=clamp(input.support_risk);
  const inactivityDays=daysSince(input.last_activity_at,now);
  const inactivityRisk=inactivityDays===null?0:clamp(inactivityDays/90);
  const score=clamp((adoption*0.35)+(satisfaction*0.35)+((1-supportRisk)*0.2)+((1-inactivityRisk)*0.1));
  return Object.freeze({score,inactivity_days:inactivityDays,risk:score<0.4?'high':score<0.7?'medium':'low'});
}
export function nextCustomerAction(input={},now=new Date()){
  const health=customerHealth(input,now);
  const purchases=Math.max(0,Math.trunc(Number(input.purchases)||0));
  const delivered=input.delivered===true;
  const onboarded=input.onboarding_complete===true;
  const supportOpen=Math.max(0,Math.trunc(Number(input.open_support_tickets)||0));
  const referralEligible=input.referral_eligible===true;
  if(!delivered) return Object.freeze({stage:'onboarding',action:'await_fulfillment',priority:'high',health});
  if(!onboarded) return Object.freeze({stage:'onboarding',action:'complete_onboarding',priority:'high',health});
  if(supportOpen>0) return Object.freeze({stage:'support',action:'resolve_support',priority:'high',health});
  if(health.risk==='high') return Object.freeze({stage:'win_back',action:'retention_intervention',priority:'high',health});
  if(Number(input.adoption_score)<0.7) return Object.freeze({stage:'adoption',action:'increase_adoption',priority:'medium',health});
  if(Number(input.satisfaction_score)<0.8) return Object.freeze({stage:'satisfaction',action:'collect_and_improve_csat',priority:'medium',health});
  if(purchases<2) return Object.freeze({stage:'repurchase',action:'repurchase_offer',priority:'medium',health});
  if(input.upsell_eligible===true) return Object.freeze({stage:'upsell',action:'upsell_offer',priority:'medium',health});
  if(input.cross_sell_eligible===true) return Object.freeze({stage:'cross_sell',action:'cross_sell_offer',priority:'medium',health});
  if(referralEligible) return Object.freeze({stage:'referral',action:'request_referral',priority:'low',health});
  return Object.freeze({stage:'retention',action:'maintain_relationship',priority:'low',health});
}

export function churnState(input={},now=new Date()){
  const health=customerHealth(input,now);
  const explicit=input.cancelled===true||input.refunded_terminal===true;
  const churned=explicit || (health.inactivity_days!==null && health.inactivity_days>=180);
  return Object.freeze({churned,reason:explicit?'explicit_exit':churned?'prolonged_inactivity':null,health});
}
