import { createHash } from 'node:crypto';
import { createCreativeSpec } from './creativeEngine.mjs';

const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,Number(v)||0));
const hash=(v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const words=(v)=>String(v||'').trim().split(/\s+/).filter(Boolean);
const layouts=Object.freeze(['editorial','contrast','proof']);
const videoChannels=new Set(['youtube','tiktok']);

export const CREATIVE_INTELLIGENCE_POLICY=Object.freeze({
  version:'creative-intelligence-v1', variants:3, min_quality_score:0.72,
  min_observed_sessions:30, min_observed_paid:3, exploration_rate:0.10, cold_start_exploration_rate:0.20,
});

export function creativeQualityScore(spec={}){
  const hookWords=words(spec.hook).length,bodyWords=words(spec.body).length,ctaWords=words(spec.cta).length;
  const hook=hookWords>=3&&hookWords<=16?1:hookWords>=2&&hookWords<=22?.75:.35;
  const body=bodyWords>=5&&bodyWords<=34?1:bodyWords>=3&&bodyWords<=48?.7:.35;
  const cta=ctaWords>=1&&ctaWords<=7?1:.45;
  const brand=spec.brand==='ZEVANORY'&&spec.site==='zevanory.api.br'?1:0;
  const dimensions=Number(spec.width)>=320&&Number(spec.height)>=320?1:0;
  const layout=layouts.includes(String(spec.layout))?1:.5;
  return Number((hook*.22+body*.20+cta*.14+brand*.18+dimensions*.14+layout*.12).toFixed(4));
}
export function buildCreativeVariants({offerId='OFFER-0001',channel='instagram',hook='',body='',cta='',objective='awareness',campaignId=''}={}){
  const base=String(hook||'Automacao com controle').trim();
  const value=String(body||'IA, execucao segura e evidencia real.').trim();
  const action=String(cta||'Conheca a ZEVANORY').trim();
  const campaign=String(campaignId||hash({offerId,channel,base,value,objective}).slice(0,16));
  const hooks=[base,`${base}: menos atrito, mais controle`,`${base} com evidencia antes de escala`];
  return Object.freeze(hooks.map((h,index)=>{
    const spec=createCreativeSpec({offerId,channel,hook:h,body:value,cta:action,objective,
      layout:layouts[index%layouts.length],formatName:videoChannels.has(String(channel))?'short_vertical':'social_static',
      campaignId:campaign,variantId:`v${index+1}`});
    return Object.freeze({spec,quality_score:creativeQualityScore(spec),variant_id:spec.variant_id});
  }));
}

export function rankCreativeVariants(variants=[],observed=[] ,policy=CREATIVE_INTELLIGENCE_POLICY){
  const evidence=new Map(observed.map(row=>[String(row.variant_id||''),row]));
  const ranked=variants.map(item=>{
    const obs=evidence.get(item.variant_id)||{}; const sessions=Math.max(0,Number(obs.sessions)||0),paid=Math.max(0,Number(obs.paid)||0);
    const observedReady=sessions>=policy.min_observed_sessions&&paid>=policy.min_observed_paid;
    const paidRate=observedReady?clamp(paid/sessions):null;
    const score=observedReady?Number((item.quality_score*.45+paidRate*.55).toFixed(4)):item.quality_score;
    return Object.freeze({...item,observed_ready:observedReady,sessions,paid,paid_rate:paidRate,selection_score:score});
  });
  const hasObservedReady=ranked.some(x=>x.observed_ready);
  ranked.sort((a,b)=>(hasObservedReady?(Number(b.observed_ready)-Number(a.observed_ready)):0)||(b.selection_score-a.selection_score)||a.variant_id.localeCompare(b.variant_id));
  return Object.freeze(ranked);
}

export function selectCreativeVariant(input={},observed=[],policy=CREATIVE_INTELLIGENCE_POLICY){
  const variants=buildCreativeVariants(input),ranking=rankCreativeVariants(variants,observed,policy),winner=ranking[0];
  const observedWinner=ranking[0]?.observed_ready===true;
  return Object.freeze({policy_version:policy.version,winner,ranking,
    selection_basis:observedWinner?'observed_outcomes_plus_quality':'quality_only_no_observed_winner',
    performance_claim_allowed:observedWinner,exploration_rate:observedWinner?policy.exploration_rate:0});
}
export async function loadCreativeOutcomeEvidence(sql,campaignId){
  const campaign=String(campaignId||'').trim(); if(!campaign)return [];
  return sql.query(`with attributed as (
    select distinct on(session_id) session_id,payload->>'variant_id' variant_id
    from telemetry_events where payload->>'campaign_id'=$1 and coalesce(payload->>'variant_id','')<>''
    order by session_id,occurred_at asc
  ), paid as (
    select distinct o.session_id from orders o join financial_events fe on fe.order_id=o.order_id
    where fe.normalized_event='payment_confirmed'
  )
  select a.variant_id,count(*)::int sessions,count(*) filter(where p.session_id is not null)::int paid
  from attributed a left join paid p on p.session_id=a.session_id group by a.variant_id`,[campaign]);
}

export async function selectCreativeVariantWithEvidence(sql,input={},policy=CREATIVE_INTELLIGENCE_POLICY){
  const variants=buildCreativeVariants(input); const campaignId=variants[0]?.spec?.campaign_id||'';
  const observed=sql&&campaignId?await loadCreativeOutcomeEvidence(sql,campaignId):[];
  return selectCreativeVariant(input,observed,policy);
}

export function chooseCreativeForOperation(selection,operationKey='',policy=CREATIVE_INTELLIGENCE_POLICY){
  const ranking=Array.isArray(selection?.ranking)?selection.ranking:[]; if(!ranking.length)throw new Error('creative_ranking_empty');
  const rate=selection.performance_claim_allowed?policy.exploration_rate:policy.cold_start_exploration_rate;
  const hex=hash({operation_key:String(operationKey||''),campaign_id:ranking[0]?.spec?.campaign_id||''});
  const bucket=parseInt(hex.slice(0,8),16)/0xffffffff; let index=0;
  if(ranking.length>1&&bucket<rate) index=1+(parseInt(hex.slice(8,12),16)%(ranking.length-1));
  return Object.freeze({selected:ranking[index],explored:index>0,exploration_rate:rate,
    basis:index>0?'bounded_exploration':selection.selection_basis,performance_claim_allowed:selection.performance_claim_allowed&&index===0});
}