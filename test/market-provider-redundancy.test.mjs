import test from 'node:test';
import assert from 'node:assert/strict';
import {collectHackerNewsMarketSignal,collectGitHubMarketSignal} from '../src/nativeMarketProviders.mjs';
import {marketResearchReadiness} from '../src/marketResearchFabric.mjs';

test('Hacker News signal is verified even with zero hits',async()=>{
 const fetchImpl=async()=>new Response(JSON.stringify({hits:[],nbHits:0}),{status:200,headers:{'content-type':'application/json'}});
 const r=await collectHackerNewsMarketSignal('tema',{fetchImpl});
 assert.equal(r.ok,true);assert.equal(r.evidence.verified,true);assert.equal(r.organization,'hacker-news');
});

test('GitHub signal is verified from repository search',async()=>{
 const body={total_count:3,items:[{stargazers_count:5,updated_at:new Date().toISOString()}]};
 const fetchImpl=async()=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 const r=await collectGitHubMarketSignal('tema',{fetchImpl});
 assert.equal(r.ok,true);assert.equal(r.evidence.verified,true);assert.equal(r.organization,'github');
});

test('native readiness exposes eleven-source free mesh',()=>{
 const r=marketResearchReadiness({});
 assert.equal(r.native.hacker_news,true);assert.equal(r.native.github,true);assert.equal(r.configured,9);
});