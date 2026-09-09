import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePrelaunchInvestment,rankPrelaunchPortfolio,economicHypothesis,canonicalExecutionFit} from '../src/prelaunchInvestment.mjs';

const evidence=['a','b','c'].map((x,i)=>({source:x,organization:`org-${i}`,source_url:`https://example${i}.com/e`,observed_at:new Date().toISOString(),verified:true,conflict:false}));
const product={sku:'P1',product:'IA para Vendas',offer_type:'digital_product',delivery_mode:'digital',artifact_sha256:'a'.repeat(64),status:'ready_for_pilot_not_published',pilot_price_brl:197};
const strong={demand:.9,trend:.85,competition:.2,evidence};

test('prelaunch can recommend controlled TESTAR without inventing cost',()=>{
  const r=evaluatePrelaunchInvestment({product,marketInput:strong});
  assert.equal(r.decision,'TESTAR');assert.equal(r.economics.complete,false);assert.equal(r.commercial_authorized,false);assert.ok(r.blockers.includes('explicit_cost_required'));
});
test('INVESTIR requires explicit economics and complete evidence',()=>{
  const r=evaluatePrelaunchInvestment({product,marketInput:strong,economics:{expected_cost_brl:20}});
  assert.equal(r.decision,'INVESTIR');assert.equal(r.economics.complete,true);assert.equal(r.commercial_authorized,false);
});
test('insufficient independent evidence is fail closed',()=>{
  const r=evaluatePrelaunchInvestment({product,marketInput:{...strong,evidence:evidence.slice(0,2)}});
  assert.equal(r.decision,'EVIDENCIA_INSUFICIENTE');
});
test('portfolio ranking is deterministic',()=>{
  const a=evaluatePrelaunchInvestment({product:{...product,sku:'A',product:'A'},marketInput:strong});
  const b=evaluatePrelaunchInvestment({product:{...product,sku:'B',product:'B'},marketInput:{...strong,demand:.3,trend:.2}});
  const ranking=rankPrelaunchPortfolio([b,a]);assert.equal(ranking[0].product_id,'A');assert.deepEqual(ranking.map(x=>x.rank),[1,2]);
});
test('null or empty economics never becomes zero-cost proof',()=>{
  const product={sku:'P4',product:'Produto',offer_type:'digital_product',delivery_mode:'digital',artifact_sha256:'a'.repeat(64),status:'ready'};
  assert.equal(economicHypothesis(product,{expected_price_brl:100,expected_cost_brl:null}).complete,false);
  assert.equal(economicHypothesis(product,{expected_price_brl:100,expected_cost_brl:''}).complete,false);
});

test('invalid economics and deceptive readiness stay fail closed',()=>{
  const base={sku:'P5',product:'Produto',offer_type:'digital_product',delivery_mode:'digital'};
  assert.equal(economicHypothesis(base,{expected_price_brl:100,expected_cost_brl:-1}).complete,false);
  assert.ok(canonicalExecutionFit({...base,artifact_sha256:'bad',status:'not_ready'}).score<1);
});
