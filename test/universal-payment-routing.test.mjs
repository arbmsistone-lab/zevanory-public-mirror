import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentProviderCandidates, selectPaymentProvider, resolveCheckoutProviderRequest as resolveCheckoutProvider } from '../src/paymentProviders.mjs';

const bothReady={
  ASAAS_ENV:'production',ASAAS_API_KEY:'a',ASAAS_WEBHOOK_TOKEN:'aw',
  MERCADOPAGO_ENV:'production',MERCADOPAGO_ACCESS_TOKEN:'m',MERCADOPAGO_WEBHOOK_SECRET:'mw',
};

test('payment pool discovers all ready providers without mandatory primary',()=>{
  const candidates=paymentProviderCandidates(bothReady);
  assert.equal(candidates.filter(x=>x.ready).length,2);
  const chosen=selectPaymentProvider(bothReady,{operationKey:'order-42'});
  assert.equal(chosen.ready,true);
  assert.ok(['asaas','mercadopago'].includes(chosen.provider));
  assert.equal(chosen.reason,'deterministic_pool_selection');
});

test('legacy PAYMENT_PROVIDER is optional preference, not dependency',()=>{
  const chosen=selectPaymentProvider({...bothReady,PAYMENT_PROVIDER:'asaas'},{operationKey:'x'});
  assert.equal(chosen.provider,'asaas');
  assert.equal(chosen.reason,'preferred_ready');
});
test('explicit checkout provider is accepted only when that capacity is ready',()=>{
  const ok=resolveCheckoutProvider({query:{provider:'mercadopago'},body:{}},bothReady);
  assert.equal(ok.ready,true);assert.equal(ok.provider,'mercadopago');
  const blocked=resolveCheckoutProvider({query:{provider:'mercadopago'},body:{}},{ASAAS_ENV:'production',ASAAS_API_KEY:'a',ASAAS_WEBHOOK_TOKEN:'aw'});
  assert.equal(blocked.ready,false);assert.equal(blocked.reason,'explicit_unavailable');
});

test('no explicit provider selects from ready pool and no capacity fails closed',()=>{
  const selected=resolveCheckoutProvider({query:{},body:{request_id:'req-1'},url:'/api/checkout'},bothReady);
  assert.equal(selected.ready,true);assert.ok(['asaas','mercadopago'].includes(selected.provider));
  const none=resolveCheckoutProvider({query:{},body:{request_id:'req-2'},url:'/api/checkout'},{});
  assert.equal(none.ready,false);assert.equal(none.provider,null);
});
