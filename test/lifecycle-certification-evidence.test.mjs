import test from 'node:test';
import assert from 'node:assert/strict';
import { certifyLifecycleEvidence } from '../src/lifecycleCertificationEngine.mjs';

test('technical readiness alone never earns score 10',()=>{
  const result=certifyLifecycleEvidence({});
  assert.equal(result.total_dimensions,39);
  assert.equal(result.technical_ready_dimensions,39);
  assert.equal(result.proven_dimensions,0);
  assert.equal(result.approved,false);
  assert.ok(result.dimensions.every(x=>x.score===9));
});

test('generic evidence counts cannot bypass dimension policy',()=>{
  const result=certifyLifecycleEvidence({verified_evidence:{market:999,discovery:999}});
  assert.equal(result.dimensions.find(x=>x.key==='market').score,9);
  assert.equal(result.dimensions.find(x=>x.key==='discovery').score,9);
});

test('canonical observed metrics can certify only their dimension',()=>{
  const result=certifyLifecycleEvidence({paid_orders:5});
  assert.equal(result.dimensions.find(x=>x.key==='market').score,10);
  assert.equal(result.dimensions.find(x=>x.key==='payment').score,10);
  assert.equal(result.dimensions.find(x=>x.key==='icp').score,9);
});