import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceReadiness, opportunityScore, decideMarketOpportunity } from '../src/marketIntelligence.mjs';
import { evaluateProductCandidate, rankProductCandidates, investmentSummary } from '../src/productIntelligence.mjs';

const evidence=[
  {source:'Google',organization:'google',source_url:'https://google.com/a',verified:true,signal:.9},
  {source:'Shopify',organization:'shopify',source_url:'https://shopify.com/b',verified:true,signal:.8},
  {source:'Statsig',organization:'statsig',source_url:'https://statsig.com/c',verified:true,signal:.7},
];
const strong={product_id:'p1',name:'Produto forte',category:'digital',expected_price_brl:100,expected_cost_brl:20,evidence,demand:.9,trend:.85,competition:.2,margin:.9,strategic_fit:.95,execution_fit:.9};

test('evidence gate requires three verified independent organizations',()=>{
  assert.equal(evidenceReadiness(evidence.slice(0,2)).ready,false);
  assert.equal(evidenceReadiness(evidence).ready,true);
});

test('opportunity score refuses incomplete dimensions',()=>{
  const score=opportunityScore({demand:.9});
  assert.equal(score.complete,false);
  assert.ok(score.missing.includes('margin'));
});
test('strong evidence-weighted candidate can recommend invest without authorizing sales',()=>{
  const decision=decideMarketOpportunity(strong);
  assert.equal(decision.decision,'INVESTIR');
  const evaluated=evaluateProductCandidate(strong);
  assert.equal(evaluated.eligible,true);
  assert.equal(evaluated.market.decision,'INVESTIR');
});

test('conflicting evidence downgrades high score to controlled test',()=>{
  const conflicted={...strong,evidence:evidence.map((x,i)=>({...x,conflict:i===0}))};
  assert.equal(decideMarketOpportunity(conflicted).decision,'TESTAR');
});

test('product ranking is deterministic and exposes top candidate',()=>{
  const weak={...strong,product_id:'p2',name:'Produto fraco',demand:.3,trend:.2,competition:.9,margin:.25,strategic_fit:.3,execution_fit:.4};
  const ranking=rankProductCandidates([weak,strong]);
  assert.equal(ranking[0].product.product_id,'p1');
  assert.equal(ranking[0].rank,1);
  const summary=investmentSummary([weak,strong]);
  assert.equal(summary.top_candidate.product.product_id,'p1');
  assert.match(summary.rule,/salesGate/);
});
