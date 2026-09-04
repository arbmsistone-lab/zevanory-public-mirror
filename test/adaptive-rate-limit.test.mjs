import test from 'node:test';
import assert from 'node:assert/strict';
import {consumeAdaptiveWebhookRate,webhookRateProfile,resetAdaptiveWebhookRateForTests} from '../src/security/adaptiveRateLimit.mjs';

test('financial webhook profiles are tighter than Meta',()=>{
  assert.ok(webhookRateProfile('mercadopago').limit<webhookRateProfile('meta').limit);
  assert.ok(webhookRateProfile('asaas').limit<webhookRateProfile('meta').limit);
});

test('adaptive limiter blocks provider burst and exposes retry-after',()=>{
  resetAdaptiveWebhookRateForTests();
  const key='198.51.100.1:mercadopago';
  for(let i=0;i<90;i++)assert.equal(consumeAdaptiveWebhookRate({key,provider:'mercadopago',now:1000}).ok,true);
  const blocked=consumeAdaptiveWebhookRate({key,provider:'mercadopago',now:1000});
  assert.equal(blocked.ok,false);
  assert.ok(blocked.retryAfter>=45);
});

test('provider buckets and clients remain isolated',()=>{
  const another=consumeAdaptiveWebhookRate({key:'198.51.100.2:mercadopago',provider:'mercadopago',now:1000});
  assert.equal(another.ok,true);
});

test('window reset restores capacity',()=>{
  const recovered=consumeAdaptiveWebhookRate({key:'198.51.100.1:mercadopago',provider:'mercadopago',now:62_000});
  assert.equal(recovered.ok,true);
});
