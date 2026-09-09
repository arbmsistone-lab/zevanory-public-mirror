import { createHash } from 'node:crypto';
import { createCreativeSpec, creativePlacements, creativeStoryboard } from './creativeEngine.mjs';

const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,Number(v)||0));
const hash=(v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const words=(v)=>String(v||'').trim().split(/\s+/).filter(Boolean);
const layouts=Object.freeze(['editorial','contrast','proof']);
const videoChannels=new Set(['youtube','tiktok']);
const accentByLayout=Object.freeze({editorial:'#7c9cff',contrast:'#71e6b2',proof:'#f5c56b'});
const rgb=(hex)=>[1,3,5].map(i=>parseInt(String(hex).slice(i,i+2),16)/255);
const lin=(v)=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4;
const lum=(hex)=>{const [r,g,b]=rgb(hex).map(lin);return .2126*r+.7152*g+.0722*b};
const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const estimatedLines=(text,width,fontPx)=>{const chars=Math.max(6,Math.floor(Number(width)/(Math.max(10,Number(fontPx))*.56)));return Math.max(1,Math.ceil(String(text||'').length/chars));};
export function deterministicPerceptualScore(spec={},options={}){
  const W=Number(spec.width)||1080,H=Number(spec.height)||1080,video=options.video===true;
  const hookLines=estimatedLines(spec.hook,W*.74,W*.066),bodyLines=estimatedLines(spec.body,W*.74,W*.034),ctaLines=estimatedLines(spec.cta,W*.74,W*.038);
  const used=H*.29+hookLines*W*.073+W*.025+bodyLines*W*.047+W*.035;const safe=used<=H*.70?1:used<=H*.76?.65:.2;
  const totalLines=hookLines+bodyLines+ctaLines,density=clamp(1-Math.abs(totalLines-6)/8,.35,1);
  const textContrast=clamp((contrast('#f7f9fc','#101827')-4.5)/12,.45,1),accentContrast=clamp((contrast(accentByLayout[spec.layout]||'#7c9cff','#080b12')-3)/12,.35,1);
  const hierarchy=clamp(1-Math.max(0,hookLines-2)*.10-Math.max(0,bodyLines-3)*.07-Math.max(0,ctaLines-1)*.08,.45,1);const placement=creativePlacements(spec.channel).includes(String(spec.placement))?1:.4;
  let sceneScore=1,frames=[];if(video){const story=creativeStoryboard(spec);frames=story.map(scene=>{const font=scene.role==='value'?W*.052:W*.072,lines=estimatedLines(scene.text,W*.74,font),sceneSafe=lines<=6?1:.35,duration=Math.max(0,Number(scene.end_ms)-Number(scene.at_ms)),durationScore=duration>=900?1:.5;const score=Number((sceneSafe*.7+durationScore*.3).toFixed(4));return Object.freeze({mode:scene.role,lines,overflow:sceneSafe<1,score,render_sane:true})});sceneScore=Math.min(...frames.map(f=>f.score));}
  const score=Number((textContrast*.18+accentContrast*.12+safe*.22+density*.14+hierarchy*.12+placement*.10+sceneScore*.12).toFixed(4));
  return Object.freeze({perceptual_score:score,min_frame_score:video?sceneScore:score,frames:Object.freeze(frames),metrics:Object.freeze({hook_lines:hookLines,body_lines:bodyLines,cta_lines:ctaLines,safe_area_score:safe,density_score:density,text_contrast:Number(textContrast.toFixed(4)),accent_contrast:Number(accentContrast.toFixed(4)),placement_score:placement})});
}

export const CREATIVE_INTELLIGENCE_POLICY=Object.freeze({
  version:'creative-intelligence-v2',variants:3,min_quality_score:0.72,min_perceptual_score:0.70,
  min_observed_sessions:30,min_observed_paid:3,exploration_rate:0.10,cold_start_exploration_rate:0.20,
  structural_weight:0.40,perceptual_weight:0.60,
});

export function creativeQualityScore(spec={}){
  const hookWords=words(spec.hook).length,bodyWords=words(spec.body).length,ctaWords=words(spec.cta).length;
  const hook=hookWords>=3&&hookWords<=16?1:hookWords>=2&&hookWords<=22?.75:.35;
  const body=bodyWords>=5&&bodyWords<=34?1:bodyWords>=3&&bodyWords<=48?.7:.35;
  const cta=ctaWords>=1&&ctaWords<=7?1:.45;
  const brand=spec.brand==='ZEVANORY'&&spec.site==='zevanory.api.br'?1:0;
  const dimensions=Number(spec.width)>=320&&Number(spec.height)>=320?1:0;
  const layout=layouts.includes(String(spec.layout))?1:.5;
  const placement=creativePlacements(spec.channel).includes(String(spec.placement))?1:.4;
  return Number((hook*.20+body*.18+cta*.12+brand*.17+dimensions*.12+layout*.11+placement*.10).toFixed(4));
}
export function buildCreativeVariants({offerId='OFFER-0001',channel='instagram',hook='',body='',cta='',objective='awareness',placement='',campaignId=''}={}){
  const base=String(hook||'Automacao com controle').trim();
  const value=String(body||'IA, execucao segura e evidencia real.').trim();
  const action=String(cta||'Conheca a ZEVANORY').trim();
  const campaign=String(campaignId||hash({offerId,channel,base,value,objective,placement}).slice(0,16));
  const hooks=[base,`${base}: menos atrito, mais controle`,`${base} com evidencia antes de escala`];
  return Object.freeze(hooks.map((h,index)=>{
    const spec=createCreativeSpec({offerId,channel,hook:h,body:value,cta:action,objective,placement,
      layout:layouts[index%layouts.length],formatName:videoChannels.has(String(channel))?'short_vertical':'social_static',
      campaignId:campaign,variantId:`v${index+1}`});
    return Object.freeze({spec,structural_score:creativeQualityScore(spec),quality_score:creativeQualityScore(spec),variant_id:spec.variant_id});
  }));
}

export function buildChannelPlacementSet(input={}){
  const channel=String(input.channel||'instagram').toLowerCase();
  return Object.freeze(creativePlacements(channel).map(placement=>createCreativeSpec({...input,channel,placement,variantId:`placement-${placement}`})));
}

const economicFields=(obs={})=>{
  const sessions=Math.max(0,Number(obs.sessions)||0),paid=Math.max(0,Number(obs.paid)||0);
  const gross=Math.max(0,Number(obs.gross_revenue_brl)||0),refunds=Math.max(0,Number(obs.refunded_brl)||0);
  const net=Math.max(0,Number(obs.net_revenue_brl ?? gross-refunds)||0);
  return {sessions,paid,gross_revenue_brl:gross,refunded_brl:Math.min(refunds,gross||refunds),net_revenue_brl:net,
    paid_rate:sessions?paid/sessions:0,refund_rate:gross?Math.min(1,refunds/gross):0,net_per_session:sessions?net/sessions:0};
};
export function rankCreativeVariants(variants=[],observed=[],policy=CREATIVE_INTELLIGENCE_POLICY){
  const evidence=new Map(observed.map(row=>[String(row.variant_id||''),row]));
  const base=variants.map(item=>{
    const econ=economicFields(evidence.get(item.variant_id)||{});
    const observedReady=econ.sessions>=policy.min_observed_sessions&&econ.paid>=policy.min_observed_paid;
    return {...item,...econ,observed_ready:observedReady};
  });
  const maxNet=Math.max(0,...base.filter(x=>x.observed_ready).map(x=>x.net_per_session));
  const ranked=base.map(item=>{
    if(!item.observed_ready)return Object.freeze({...item,selection_score:Number(item.quality_score)});
    const netIndex=maxNet>0?clamp(item.net_per_session/maxNet):0;
    const economicScore=item.paid_rate*.30+netIndex*.35+(1-item.refund_rate)*.15+Number(item.quality_score)*.20;
    return Object.freeze({...item,economic_score:Number(economicScore.toFixed(4)),selection_score:Number(economicScore.toFixed(4))});
  });
  const hasObservedReady=ranked.some(x=>x.observed_ready);
  ranked.sort((a,b)=>(hasObservedReady?(Number(b.observed_ready)-Number(a.observed_ready)):0)||(b.selection_score-a.selection_score)||a.variant_id.localeCompare(b.variant_id));
  return Object.freeze(ranked);
}

const selectionFromRanking=(ranking,policy=CREATIVE_INTELLIGENCE_POLICY)=>{
  const winner=ranking[0],observedWinner=winner?.observed_ready===true,visual=Number.isFinite(Number(winner?.perceptual_score));
  const basis=observedWinner?(visual?'observed_economics_plus_perceptual_quality':'observed_economics_plus_structural_quality'):(visual?'perceptual_quality_no_observed_winner':'structural_quality_no_observed_winner');
  return Object.freeze({policy_version:policy.version,winner,ranking,selection_basis:basis,
    performance_claim_allowed:observedWinner,exploration_rate:observedWinner?policy.exploration_rate:0});
};

export function selectCreativeVariant(input={},observed=[],policy=CREATIVE_INTELLIGENCE_POLICY){
  return selectionFromRanking(rankCreativeVariants(buildCreativeVariants(input),observed,policy),policy);
}
export async function loadCreativeOutcomeEvidence(sql,campaignId){
  const campaign=String(campaignId||'').trim(); if(!campaign)return [];
  return sql.query(`with attributed as (
    select distinct on(session_id) session_id,payload->>'variant_id' variant_id
    from telemetry_events where payload->>'campaign_id'=$1 and coalesce(payload->>'variant_id','')<>''
    order by session_id,occurred_at asc
  ), payment_rollup as (
    select o.session_id,fe.provider_payment_id,
      max(case when fe.normalized_event='payment_confirmed' then fe.amount else 0 end)::numeric gross,
      max(case when fe.normalized_event='refund_confirmed' then coalesce(fe.refunded_total,fe.amount,0) else 0 end)::numeric refunded
    from orders o join financial_events fe on fe.order_id=o.order_id group by o.session_id,fe.provider_payment_id
  ), economics as (
    select session_id,sum(gross)::numeric gross,sum(refunded)::numeric refunded from payment_rollup group by session_id
  )
  select a.variant_id,count(*)::int sessions,count(*) filter(where coalesce(e.gross,0)>0)::int paid,
    coalesce(sum(e.gross),0)::numeric gross_revenue_brl,coalesce(sum(e.refunded),0)::numeric refunded_brl,
    coalesce(sum(greatest(e.gross-e.refunded,0)),0)::numeric net_revenue_brl
  from attributed a left join economics e on e.session_id=a.session_id group by a.variant_id`,[campaign]);
}

export async function selectCreativeVariantWithEvidence(sql,input={},policy=CREATIVE_INTELLIGENCE_POLICY){
  const variants=buildCreativeVariants(input),campaignId=variants[0]?.spec?.campaign_id||'';
  const observed=sql&&campaignId?await loadCreativeOutcomeEvidence(sql,campaignId):[];
  return selectionFromRanking(rankCreativeVariants(variants,observed,policy),policy);
}

export async function selectCreativeVariantWithVisualEvidence(sql,input={},policy=CREATIVE_INTELLIGENCE_POLICY,{visualEvaluator=null}={}){
  const variants=buildCreativeVariants(input),campaignId=variants[0]?.spec?.campaign_id||'',video=videoChannels.has(String(input.channel||''));
  const observed=sql&&campaignId?await loadCreativeOutcomeEvidence(sql,campaignId):[];
  const evaluator=visualEvaluator||((spec,options)=>deterministicPerceptualScore(spec,options));
  const visuals=await Promise.all(variants.map(item=>evaluator(item.spec,{video})));
  const enriched=variants.map((item,index)=>{const visual=visuals[index]||{};const perceptual=Number(visual?.perceptual_score)||0;const quality=Number((item.structural_score*policy.structural_weight+perceptual*policy.perceptual_weight).toFixed(4));return Object.freeze({...item,perceptual_score:perceptual,visual_min_frame_score:Number(visual?.min_frame_score)||perceptual,visual_frames:visual?.frames||[],quality_score:quality});});
  return selectionFromRanking(rankCreativeVariants(enriched,observed,policy),policy);
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
