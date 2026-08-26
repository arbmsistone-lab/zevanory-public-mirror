import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE } from '../src/release.mjs';

test('release fingerprint is canonical and immutable',()=>{
  assert.equal(RELEASE.id,'ZEVANORY-EG0032-FINAL');
  assert.equal(Object.isFrozen(RELEASE),true);
  assert.equal(RELEASE.structuralCompletion,'operations-console-ready');
  assert.equal(RELEASE.assurance.audit_30x,'approved');
  assert.equal(RELEASE.recovery.tables,7);
  assert.equal(RELEASE.recovery.migrations,6);
  assert.equal(RELEASE.salesMode,'globally-blocked');
  assert.equal(RELEASE.checkoutMode,'globally-blocked');
});

test('release manifest requires all production surfaces',()=>{
  for(const route of ['/','/piloto','/api/config','/api/health','/api/live','/api/status','/api/events/public','/api/checkout/asaas','/api/webhooks/asaas','/api/release']) assert.equal(RELEASE.requiredRoutes.includes(route),true);
});
