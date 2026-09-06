import test from 'node:test';
import assert from 'node:assert/strict';
import { ZEVANORY_PRODUCTS, getZevanoryProduct, publicProductCatalog } from '../src/offerCatalog.mjs';

test('ZEVANORY v1.1 catalog contains the three handoff products',()=>{
  assert.equal(ZEVANORY_PRODUCTS.length,3);
  assert.deepEqual(ZEVANORY_PRODUCTS.map(x=>x.sku),['ZEV-IA-011','ZEV-VEN-011','ZEV-CMB-011']);
});

test('Combo is the single primary offer and keeps pilot pricing hypothesis',()=>{
  const primary=ZEVANORY_PRODUCTS.filter(x=>x.primary);
  assert.equal(primary.length,1);
  assert.equal(primary[0].sku,'ZEV-CMB-011');
  assert.equal(primary[0].table_price_brl,297);
  assert.equal(primary[0].pilot_price_brl,247);
  assert.equal(primary[0].price_status,'pilot_hypothesis_not_validated');
});

test('individual products retain registered prices and immutable artifact hashes',()=>{
  assert.equal(getZevanoryProduct('zev-ia-011').pilot_price_brl,147);
  assert.equal(getZevanoryProduct('ZEV-VEN-011').table_price_brl,197);
  for(const item of ZEVANORY_PRODUCTS) assert.match(item.artifact_sha256,/^[a-f0-9]{64}$/);
});

test('public catalog stays non-published and exposes no supplier CPF',()=>{
  const catalog=publicProductCatalog();
  assert.equal(catalog.length,3);
  assert.ok(catalog.every(x=>x.status.includes('not_published')));
  assert.equal(JSON.stringify(catalog).includes('cpf'),false);
});

import { normalizeCheckoutRequest, checkoutReplayDecision, buildAsaasCheckoutPayload } from '../src/order.mjs';
import { buildMercadoPagoPreference } from '../src/mercadopago.mjs';

test('checkout resolves each ZEVANORY SKU to its own pilot price',()=>{
  const request=normalizeCheckoutRequest({request_id:'123e4567-e89b-42d3-a456-426614174000',session_id:'123e4567-e89b-42d3-a456-426614174001',offer_id:'ZEV-CMB-011'});
  assert.equal(request.offer.id,'ZEV-CMB-011');
  assert.equal(request.offer.price_brl,247);
  const asaas=buildAsaasCheckoutPayload('123e4567-e89b-42d3-a456-426614174002','https://zevanory.api.br',request.offer);
  assert.equal(asaas.items[0].value,247);
  const mp=buildMercadoPagoPreference('123e4567-e89b-42d3-a456-426614174002','https://zevanory.api.br',request.offer);
  assert.equal(mp.items[0].id,'ZEV-CMB-011');
  assert.equal(mp.items[0].unit_price,247);
});

test('idempotent replay rejects request reuse across different products',()=>{
  const order={session_id:'123e4567-e89b-42d3-a456-426614174001',offer_id:'ZEV-IA-011',status:'checkout_ready',checkout_url:'https://example.invalid'};
  assert.equal(checkoutReplayDecision(order,order.session_id,'ZEV-CMB-011').action,'offer_conflict');
});
