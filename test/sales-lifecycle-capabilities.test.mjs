import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SALES_LIFECYCLE_CANONICAL_V2 } from '../src/salesLifecycleV2.mjs';
import { SALES_LIFECYCLE_CAPABILITIES,assessLifecycleCapabilityCoverage } from '../src/salesLifecycleCapabilities.mjs';

test('all 39 canonical lifecycle dimensions have an explicit capability owner',()=>{
  const coverage=assessLifecycleCapabilityCoverage();
  assert.equal(coverage.complete,true);
  assert.equal(coverage.total,39);
  assert.deepEqual(Object.keys(SALES_LIFECYCLE_CAPABILITIES),[...SALES_LIFECYCLE_CANONICAL_V2]);
});

test('every declared capability owner resolves to an existing source module',()=>{
  for(const [key,entry] of Object.entries(SALES_LIFECYCLE_CAPABILITIES)){
    const owners=String(entry.owner).split('|');
    assert.ok(owners.length>=1,key);
    for(const owner of owners) assert.equal(fs.existsSync(new URL(`../src/${owner}`,import.meta.url)),true,`${key}:${owner}`);
  }
});

test('capability coverage does not grant certification score',async()=>{
  const {salesLifecycleGate}=await import('../src/salesLifecycleV2.mjs');
  assert.equal(assessLifecycleCapabilityCoverage().complete,true);
  assert.equal(salesLifecycleGate().approved,false);
  assert.equal(salesLifecycleGate().passed_dimensions,0);
});
