import test from 'node:test';
import assert from 'node:assert/strict';
import { marketResearchFeeds, marketResearchReadiness, collectMarketSignals, aggregateMarketSignals } from '../src/marketResearchFabric.mjs';

const env={MARKET_RESEARCH_FEEDS:JSON.stringify([
  {name:'A',organization:'org-a',url:'https://a.example/feed'},
  {name:'B',organization:'org-b',url:'https://b.example/feed'},
  {name:'C',organization:'org-c',url:'https://c.example/feed'},
])};

test('research fabric requires three independent configured feeds',()=>{
  assert.equal(marketResearchFeeds(env).length,3);
  assert.equal(marketResearchReadiness(env).ready,true);
  assert.equal(marketResearchReadiness({MARKET_RESEARCH_FEEDS:'[]'}).ready,false);
});

test('research fabric aggregates only verified provider signals',async()=>{
  const fetchImpl=async()=>({ok:true,status:200,json:async()=>({verified:true,signal:.8,metrics:{demand:.9,trend:.8,competition:.2,margin:.9,strategic_fit:.9,execution_fit:.9}})});
  const rows=await collectMarketSignals('Produto X',{env,fetchImpl});
  assert.equal(rows.length,3);
  const aggregate=aggregateMarketSignals('Produto X',rows);
  assert.equal(aggregate.verified,3);
  assert.equal(aggregate.decision.decision,'INVESTIR');
});
