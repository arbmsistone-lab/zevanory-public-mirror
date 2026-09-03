import test from 'node:test';
import assert from 'node:assert/strict';
import { SALES_LIFECYCLE_CANONICAL_V2 } from '../src/salesLifecycleV2.mjs';
import { certifyLifecycleEvidence } from '../src/lifecycleCertificationEngine.mjs';

test('technical readiness alone never earns score 10',()=>{
  const result=certifyLifecycleEvidence({});
  assert.equal(result.total_dimensions,39);
  assert.equal(result.technical_ready_dimensions,39);
  assert.equal(result.proven_dimensions,0);
  assert.equal(result.approved,false);
  assert.ok(result.dimensions.every(x=>x.score===9));
});

test('three observed production proofs can certify a dimension',()=>{
  const result=certifyLifecycleEvidence({verified_evidence:{discovery:3}});
  const discovery=result.dimensions.find(x=>x.key==='discovery');
  assert.equal(discovery.score,10);
  assert.equal(discovery.pass,true);
  assert.equal(result.approved,false);
});
