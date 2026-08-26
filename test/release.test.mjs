import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE } from '../src/release.mjs';
import handler from '../api/release.mjs';

function mock(method='GET'){
  const headers={};
  return {req:{method},res:{statusCode:200,body:'',setHeader(k,v){headers[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers}};
}

test('release fingerprint is canonical and immutable',()=>{
  assert.equal(RELEASE.id,'ZEVANORY-EG0032-FINAL');
  assert.equal(Object.isFrozen(RELEASE),true);
  assert.equal(RELEASE.structuralCompletion,'sales-machine-ready');
  assert.equal(RELEASE.salesMode,'globally-blocked');
  assert.equal(RELEASE.checkoutMode,'globally-blocked');
});

test('release manifest requires all production surfaces',()=>{
  for(const route of ['/','/piloto','/api/config','/api/health','/api/live','/api/status','/api/events/public','/api/checkout/asaas','/api/webhooks/asaas','/api/release']) {
    assert.equal(RELEASE.requiredRoutes.includes(route),true);
  }
});
