import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE } from '../src/release.mjs';

test('release fingerprint is canonical and immutable',()=>{
  assert.equal(RELEASE.id,'ZEVANORY-EG0036-FINAL');
  assert.equal(Object.isFrozen(RELEASE),true);
  assert.equal(RELEASE.structuralCompletion,'composable-commerce-infrastructure-ready');
  assert.equal(RELEASE.commercialModel,'no-inventory');
  assert.equal(RELEASE.assurance.autonomous_engine_20x,'approved');
  assert.equal(RELEASE.assurance.composable_10x5,'approved');
  assert.equal(RELEASE.recovery.tables,15);
  assert.equal(RELEASE.recovery.migrations,9);
  assert.equal(RELEASE.salesMode,'globally-blocked');
  assert.equal(RELEASE.checkoutMode,'globally-blocked');
});

test('release manifest requires all production surfaces',()=>{
  for(const route of ['/','/piloto','/termos','/privacidade','/reembolso','/afiliados','/api/config','/api/health','/api/live','/api/status','/api/events/public','/api/events/operator','/api/agent/status','/api/agent/run','/api/checkout/asaas','/api/webhooks/asaas','/api/release']) assert.equal(RELEASE.requiredRoutes.includes(route),true);
});
