import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOpenAlexMarketSignal} from '../src/nativeMarketProviders.mjs';
import {marketResearchReadiness} from '../src/marketResearchFabric.mjs';

test('OpenAlex is a native verified zero-credential research source',async()=>{
  const fetchImpl=async url=>{
    const u=new URL(String(url));
    assert.equal(u.hostname,'api.openalex.org');
    assert.equal(u.searchParams.get('search'),'gerenciamento de risco');
    return new Response(JSON.stringify({meta:{count:120},results:[{publication_year:new Date().getUTCFullYear(),cited_by_count:9}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const row=await collectOpenAlexMarketSignal('gerenciamento de risco',{fetchImpl,timeoutMs:1000});
  assert.equal(row.organization,'openalex');
  assert.equal(row.ok,true);
  assert.equal(row.evidence.verified,true);
  assert.equal(row.status,200);
});

test('market readiness counts OpenAlex without credentials',()=>{
  const r=marketResearchReadiness({});
  assert.equal(r.native.openalex,true);
  assert.ok(r.configured>=7);
  assert.equal(r.ready,true);
});
