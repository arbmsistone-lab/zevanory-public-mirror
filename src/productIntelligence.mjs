import { decideMarketOpportunity, sanitizeEvidence } from './marketIntelligence.mjs';

const clean=(v,max=300)=>String(v||'').trim().slice(0,max);
const safeMoney=(v)=>Number.isFinite(Number(v))?Number(v):null;

export function evaluateProductCandidate(input={}){
  const market=decideMarketOpportunity(input);
  const product=Object.freeze({
    product_id:clean(input.product_id||input.id,120),
    name:clean(input.name,180),
    category:clean(input.category,120),
    source_type:clean(input.source_type||'unknown',60),
    expected_price_brl:safeMoney(input.expected_price_brl),
    expected_cost_brl:safeMoney(input.expected_cost_brl),
    evidence:sanitizeEvidence(input.evidence),
  });
  const economics=product.expected_price_brl!==null&&product.expected_cost_brl!==null
    ? Object.freeze({gross_margin_brl:product.expected_price_brl-product.expected_cost_brl,gross_margin_rate:product.expected_price_brl>0?(product.expected_price_brl-product.expected_cost_brl)/product.expected_price_brl:null})
    : null;
  const blockers=[];
  if(!product.product_id)blockers.push('product_id_required');
  if(!product.name)blockers.push('product_name_required');
  if(economics&&economics.gross_margin_brl<=0)blockers.push('non_positive_gross_margin');
  return Object.freeze({product,market,economics,blockers:Object.freeze(blockers),eligible:blockers.length===0});
}
export function rankProductCandidates(candidates=[]){
  const evaluated=(Array.isArray(candidates)?candidates:[]).map(evaluateProductCandidate);
  const decisionWeight={INVESTIR:5,TESTAR:4,AGUARDAR:3,EVIDENCIA_INSUFICIENTE:2,DESCARTAR:1};
  evaluated.sort((a,b)=>
    (decisionWeight[b.market.decision]||0)-(decisionWeight[a.market.decision]||0)||
    Number(b.market.opportunity?.score||-1)-Number(a.market.opportunity?.score||-1)||
    Number(b.economics?.gross_margin_rate||-1)-Number(a.economics?.gross_margin_rate||-1)||
    a.product.name.localeCompare(b.product.name,'pt-BR')
  );
  return Object.freeze(evaluated.map((item,index)=>Object.freeze({...item,rank:index+1})));
}

export function investmentSummary(candidates=[]){
  const ranking=rankProductCandidates(candidates);
  const counts=Object.freeze(ranking.reduce((acc,item)=>{acc[item.market.decision]=(acc[item.market.decision]||0)+1;return acc;},{}));
  return Object.freeze({
    generated_at:new Date().toISOString(),
    total:ranking.length,
    counts,
    top_candidate:ranking[0]||null,
    ranking,
    rule:'No commercial action is authorized by this score; canonical salesGate remains mandatory.',
  });
}
