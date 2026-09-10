import { createHash } from 'node:crypto';

const clamp=(v)=>Math.max(0,Math.min(1,Number(v)||0));
const bucket=(key)=>parseInt(createHash('sha256').update(String(key)).digest('hex').slice(0,8),16)/0xffffffff;
export const DECISION_V2_POLICY=Object.freeze({holdout_rate:.05,exploration_rate:.10,min_confidence:.70,min_uplift:.02});

export function scoreDecisionCandidate(candidate={},context={}){
  const propensity=clamp(candidate.propensity),uplift=Number(candidate.uplift)||0,margin=clamp(candidate.margin_score),fit=clamp(candidate.context_fit);
  const risk=clamp(candidate.risk_score),channelFit=clamp(context.channel_fit??1);
  return Number((propensity*.28+Math.max(0,uplift)*.25+margin*.18+fit*.17+channelFit*.12-risk*.25).toFixed(4));
}
export function chooseContextualDecision({candidates=[],context={},operation_key='',policy=DECISION_V2_POLICY}={}){
  const ranked=candidates.map(c=>Object.freeze({...c,score:scoreDecisionCandidate(c,context)})).sort((a,b)=>b.score-a.score||String(a.id).localeCompare(String(b.id)));
  if(!ranked.length)return Object.freeze({ready:false,reason:'no_candidates',ranking:Object.freeze([])});
  const h=bucket(operation_key||JSON.stringify(context));
  if(h<policy.holdout_rate)return Object.freeze({ready:true,mode:'holdout',selected:null,ranking:Object.freeze(ranked),commercial_unlock:false});
  const eligible=ranked.filter(x=>clamp(x.confidence)>=policy.min_confidence&&Number(x.uplift||0)>=policy.min_uplift);
  if(!eligible.length)return Object.freeze({ready:false,reason:'insufficient_causal_evidence',ranking:Object.freeze(ranked),commercial_unlock:false});
  const explore=h<policy.holdout_rate+policy.exploration_rate&&eligible.length>1;
  const selected=explore?eligible[1]:eligible[0];
  return Object.freeze({ready:true,mode:explore?'explore':'exploit',selected,ranking:Object.freeze(ranked),commercial_unlock:false});
}
