import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutUrlForId, normalizeAsaasCheckoutResponse } from '../src/order.mjs';
import { createAsaasCheckout } from '../api/checkout/asaas.mjs';
const id='550e8400-e29b-41d4-a716-446655440000';
test('production checkout URL uses official Asaas host',()=>{
  assert.equal(checkoutUrlForId(id,'production'),`https://asaas.com/checkoutSession/show?id=${id}`);
  assert.equal(normalizeAsaasCheckoutResponse({id},'ref','production').link,`https://asaas.com/checkoutSession/show?id=${id}`);
});
test('checkout API selects production Asaas API base',async()=>{
  let url='';
  const fetchImpl=async(input)=>{url=String(input);return {ok:true,json:async()=>({id})};};
  await createAsaasCheckout({},'key','production',fetchImpl);
  assert.equal(url,'https://api.asaas.com/v3/checkouts');
});