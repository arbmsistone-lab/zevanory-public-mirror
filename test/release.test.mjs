import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE } from '../src/release.mjs';
import handler from '../api/release.mjs';

function mock(method='GET'){
  const headers={};
  return {req:{method},res:{statusCode:200,body:'',setHeader(k,v){headers[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers}};
}

test('release fingerprint is canonical and immutable',()=>{
  assert.equal(RELEASE.id,'ZEVANORY-EG0018-RC2');
  assert.equal(Object.isFrozen(RELEASE),true);
  assert.equal(RELEASE.salesMode,'globally-blocked');
  assert.equal(RELEASE.checkoutMode,'globally-blocked');
});

test('release manifest requires all production surfaces',()=>{
  for(const route of ['/','/piloto','/api/config','/api/events/public','/api/checkout/asaas','/api/webhooks/asaas','/api/release']) {
    assert.equal(RELEASE.requiredRoutes.includes(route),true);
  }
});

test('release endpoint exposes exact fingerprint and rejects writes',()=>{
  const ok=mock('GET');
  handler(ok.req,ok.res);
  assert.equal(ok.res.statusCode,200);
  const body=JSON.parse(ok.res.body);
  assert.equal(body.release_id,'ZEVANORY-EG0018-RC2');
  assert.equal(body.sales_mode,'globally-blocked');
  assert.equal(body.checkout_mode,'globally-blocked');
  const blocked=mock('POST');
  handler(blocked.req,blocked.res);
  assert.equal(blocked.res.statusCode,405);
});
