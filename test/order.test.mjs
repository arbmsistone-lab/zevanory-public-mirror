import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCheckoutRequest,
  externalReferenceForOrder,
  safePublicBaseUrl,
  buildAsaasCheckoutPayload,
  validAsaasCheckoutResponse,
} from '../src/order.mjs';

const id='550e8400-e29b-41d4-a716-446655440000';
const sid='6ba7b810-9dad-41d1-80b4-00c04fd430c8';

test('checkout request accepts only UUID request and session ids',()=>{
  assert.equal(normalizeCheckoutRequest({request_id:id,session_id:sid})?.requestId,id);
  assert.equal(normalizeCheckoutRequest({request_id:'x',session_id:sid}),null);
  assert.equal(normalizeCheckoutRequest(null),null);
});

test('order reference and public origin are canonical',()=>{
  assert.equal(externalReferenceForOrder(id),`ZEVANORY:EXP-0001:${id}`);
  assert.equal(safePublicBaseUrl('https://zevanory-site.vercel.app'),'https://zevanory-site.vercel.app');
  assert.equal(safePublicBaseUrl('https://evil.example'),'');
});

test('checkout payload is fixed to approved offer and Sandbox response',()=>{
  const payload=buildAsaasCheckoutPayload(id,'https://zevanory-site.vercel.app');
  assert.deepEqual(payload.billingTypes,['PIX','CREDIT_CARD']);
  assert.deepEqual(payload.chargeTypes,['DETACHED']);
  assert.equal(payload.items[0].value,497);
  assert.equal(payload.externalReference,`ZEVANORY:EXP-0001:${id}`);
  const response={id,externalReference:payload.externalReference,link:`https://sandbox.asaas.com/checkoutSession/show/${id}`};
  assert.equal(validAsaasCheckoutResponse(response,payload.externalReference),true);
  assert.equal(validAsaasCheckoutResponse({...response,link:`https://asaas.com/checkoutSession/show/${id}`},payload.externalReference),false);
});
