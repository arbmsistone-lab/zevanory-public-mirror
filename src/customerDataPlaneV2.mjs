import { createHash } from 'node:crypto';

const clean=(v,max=240)=>String(v??'').trim().slice(0,max);
const norm=(v)=>clean(v).toLowerCase();
const hash=(v)=>createHash('sha256').update(String(v)).digest('hex');

export function canonicalIdentityKey({email='',phone='',external_id=''}={}){
  const candidates=[norm(email),clean(phone).replace(/\D/g,''),norm(external_id)].filter(Boolean);
  return candidates.length?hash(candidates.sort().join('|')):null;
}
export function consentState(events=[]){
  const ordered=[...events].filter(x=>x?.purpose&&x?.status).sort((a,b)=>new Date(a.occurred_at||0)-new Date(b.occurred_at||0));
  const state={}; for(const e of ordered) state[norm(e.purpose)]={status:norm(e.status),source:clean(e.source,80),occurred_at:e.occurred_at||null};
  return Object.freeze(state);
}
export function buildCustomerFeatures(input={}){
  const purchases=Math.max(0,Number(input.purchases)||0),revenue=Math.max(0,Number(input.net_revenue_brl)||0);
  const recency=Math.max(0,Number(input.days_since_last_activity)||0),engagement=Math.max(0,Math.min(1,Number(input.engagement_score)||0));
  const value=Math.min(1,revenue/2000),frequency=Math.min(1,purchases/10),freshness=Math.max(0,1-Math.min(1,recency/180));
  return Object.freeze({value,frequency,freshness,engagement,composite:Number((value*.35+frequency*.2+freshness*.2+engagement*.25).toFixed(4))});
}
export function segmentCustomer(features={}){
  const c=Number(features.composite)||0,v=Number(features.value)||0,f=Number(features.freshness)||0;
  return c>=.75?'champion':v>=.6&&f<.4?'high_value_at_risk':c>=.5?'growth':f<.25?'dormant':'emerging';
}
