import { opportunityScore, evidenceReadiness } from './marketIntelligence.mjs';

const clamp=v=>Math.max(0,Math.min(1,Number(v)||0));
const money=v=>v===null||v===undefined||String(v).trim()===''?null:(Number.isFinite(Number(v))?Number(v):null);
const clean=(v,max=180)=>String(v||'').trim().slice(0,max);

export function canonicalExecutionFit(product={}){
  const status=String(product.status||'').trim().toLowerCase();
  const artifact=/^[0-9a-f]{64}$/i.test(String(product.artifact_sha256||''));
  const ready=/(^|_)ready(_|$)/.test(status)&&!/(not_ready|unready|blocked|failed)/.test(status);
  const checks=[product.offer_type==='digital_product',product.delivery_mode==='digital',artifact,ready];
  return Object.freeze({score:checks.filter(Boolean).length/checks.length,basis:'canonical_product_facts',checks:Object.freeze(checks)});
}
export function canonicalStrategicFit(product={}){
  const text=`${product.product||''} ${product.commercial_name||''}`.toLowerCase();
  const aligned=['ia','venda','negócio','negocio','lucro','caixa'].some(k=>text.includes(k));
  return Object.freeze({score:aligned?1:0.55,basis:'canonical_portfolio_alignment'});
}
export function economicHypothesis(product={},input={}){
  const price=money(input.expected_price_brl??product.pilot_price_brl??product.table_price_brl);
  const cost=money(input.expected_cost_brl);
  if(price===null||cost===null)return Object.freeze({complete:false,price_brl:price,cost_brl:cost,margin:null,reason:'explicit_cost_required'});
  if(!(price>0)||cost<0)return Object.freeze({complete:false,price_brl:price,cost_brl:cost,margin:null,reason:'invalid_explicit_economics'});
  const margin=clamp((price-cost)/price);
  return Object.freeze({complete:true,price_brl:price,cost_brl:cost,margin,reason:'explicit_price_and_cost'});
}
export function evaluatePrelaunchInvestment({product={},marketInput={},economics={}}={}){
  const execution=canonicalExecutionFit(product),strategic=canonicalStrategicFit(product),economic=economicHypothesis(product,economics);
  const evidence=evidenceReadiness(marketInput.evidence||[]);
  const scored=opportunityScore({...marketInput,strategic_fit:strategic.score,execution_fit:execution.score,margin:economic.complete?economic.margin:null});
  const marketOnly=opportunityScore({...marketInput,strategic_fit:strategic.score,execution_fit:execution.score});
  let decision='AGUARDAR',reason='market_signal_below_test_threshold';
  if(!evidence.ready){decision='EVIDENCIA_INSUFICIENTE';reason='minimum_verified_market_evidence_not_met';}
  else if(economic.complete){
    if(scored.score>=0.80) {decision='INVESTIR';reason='complete_evidence_weighted_opportunity';}
    else if(scored.score>=0.62) {decision='TESTAR';reason='complete_but_requires_controlled_validation';}
    else if(scored.score<0.38) {decision='DESCARTAR';reason='complete_score_below_floor';}
  } else if(marketOnly.score>=0.62){decision='TESTAR';reason='market_and_fit_support_controlled_test_economics_pending';}
  else if(marketOnly.score<0.38){decision='DESCARTAR';reason='market_and_fit_score_below_floor';}
  return Object.freeze({
    product_id:clean(product.sku||product.product_id||product.id,120),name:clean(product.product||product.name,180),
    decision,reason,evidence,market_score:marketOnly.score,complete_score:scored.score,economics:economic,
    strategic_fit:strategic,execution_fit:execution,commercial_authorized:false,
    blockers:Object.freeze([...(economic.complete?[]:['explicit_cost_required']),'sales_gate_required']),
  });
}

export function rankPrelaunchPortfolio(rows=[]){
  const weight={INVESTIR:5,TESTAR:4,AGUARDAR:3,EVIDENCIA_INSUFICIENTE:2,DESCARTAR:1};
  return Object.freeze([...rows].sort((a,b)=>(weight[b.decision]||0)-(weight[a.decision]||0)||Number(b.market_score||-1)-Number(a.market_score||-1)||String(a.name).localeCompare(String(b.name),'pt-BR')).map((x,i)=>Object.freeze({...x,rank:i+1})));
}