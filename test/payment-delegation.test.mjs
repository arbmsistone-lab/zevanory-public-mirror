import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentProviderReadiness } from '../src/paymentProviders.mjs';

test('delegated payment runtime requires verified origin',()=>{
  const blocked=paymentProviderReadiness({PAYMENT_PROVIDER:'mercadopago',PAYMENT_RUNTIME_MODE:'delegated'});
  assert.equal(blocked.ready,false);
  assert.deepEqual(blocked.blockers,['payment_provider_pool_unavailable']);
  assert.ok(blocked.diagnostics.some(x=>x.blockers.includes('payment_runtime_origin_unverified')));
});

test('verified delegated runtime requires explicit HTTPS allowlist and release binding',()=>{
  const ready=paymentProviderReadiness({
    PAYMENT_PROVIDER:'mercadopago',
    PAYMENT_RUNTIME_MODE:'delegated',
    PAYMENT_RUNTIME_ORIGIN:'https://zevanory.api.br',
    PAYMENT_RUNTIME_ALLOWED_ORIGINS:'https://zevanory.api.br,https://payments.example.net',
    PAYMENT_RUNTIME_ORIGIN_VERIFIED:'true',
    PAYMENT_RUNTIME_ORIGIN_RELEASE_ID:'ZEVANORY-EG0039-FINAL'
  });
  assert.equal(ready.ready,true);
  assert.equal(ready.delegated,true);
  assert.deepEqual(ready.blockers,[]);
});

test('delegated payment fails closed when origin is not allowlisted',()=>{
  const blocked=paymentProviderReadiness({
    PAYMENT_PROVIDER:'mercadopago',PAYMENT_RUNTIME_MODE:'delegated',
    PAYMENT_RUNTIME_ORIGIN:'https://evil.example',PAYMENT_RUNTIME_ALLOWED_ORIGINS:'https://zevanory.api.br',
    PAYMENT_RUNTIME_ORIGIN_VERIFIED:'true',PAYMENT_RUNTIME_ORIGIN_RELEASE_ID:'ZEVANORY-EG0039-FINAL'
  });
  assert.equal(blocked.ready,false);
  assert.ok(blocked.diagnostics.some(x=>x.blockers.includes('payment_runtime_origin_unverified')));
});


test('local payment credentials automatically override delegated fallback',()=>{
  const ready=paymentProviderReadiness({
    PAYMENT_PROVIDER:'mercadopago',PAYMENT_RUNTIME_MODE:'delegated',
    PAYMENT_RUNTIME_ORIGIN:'https://zevanory-site.vercel.app',PAYMENT_RUNTIME_ALLOWED_ORIGINS:'https://zevanory-site.vercel.app',
    PAYMENT_RUNTIME_ORIGIN_VERIFIED:'true',PAYMENT_RUNTIME_ORIGIN_RELEASE_ID:'ZEVANORY-EG0039-FINAL',
    MERCADOPAGO_ENV:'production',MERCADOPAGO_ACCESS_TOKEN:'local-token',MERCADOPAGO_WEBHOOK_SECRET:'local-webhook'
  });
  assert.equal(ready.ready,true); assert.equal(ready.delegated,false);
});