import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentProviderReadiness } from '../src/paymentProviders.mjs';

test('delegated payment runtime requires verified origin',()=>{
  const blocked=paymentProviderReadiness({PAYMENT_PROVIDER:'mercadopago',PAYMENT_RUNTIME_MODE:'delegated'});
  assert.equal(blocked.ready,false);
  assert.ok(blocked.blockers.includes('payment_runtime_origin_unverified'));
});

test('verified delegated runtime does not require duplicate local payment secrets',()=>{
  const ready=paymentProviderReadiness({
    PAYMENT_PROVIDER:'mercadopago',
    PAYMENT_RUNTIME_MODE:'delegated',
    PAYMENT_RUNTIME_ORIGIN_VERIFIED:'true'
  });
  assert.equal(ready.ready,true);
  assert.equal(ready.delegated,true);
  assert.deepEqual(ready.blockers,[]);
});
