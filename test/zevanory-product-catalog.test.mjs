import test from 'node:test';
import assert from 'node:assert/strict';
import { ZEVANORY_PRODUCTS, getZevanoryProduct, publicProductCatalog } from '../src/offerCatalog.mjs';

test('ZEVANORY v2.1 catalog contains the five certified handoff products',()=>{
  assert.equal(ZEVANORY_PRODUCTS.length,5);
  assert.deepEqual(ZEVANORY_PRODUCTS.map(x=>x.sku),['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011','ZEV-CMB-011','ZEV-NGC-011']);
});

test('Negócio Completo is the single primary offer and keeps pilot pricing hypothesis',()=>{
  const primary=ZEVANORY_PRODUCTS.filter(x=>x.primary);
  assert.equal(primary.length,1);
  assert.equal(primary[0].sku,'ZEV-NGC-011');
  assert.equal(primary[0].table_price_brl,397);
  assert.equal(primary[0].pilot_price_brl,347);
  assert.equal(primary[0].price_status,'pilot_hypothesis_not_validated');
});

test('individual products retain registered prices and immutable artifact hashes',()=>{
  assert.equal(getZevanoryProduct('zev-ia-011').pilot_price_brl,147);
  assert.equal(getZevanoryProduct('ZEV-VEN-011').table_price_brl,197);
  assert.equal(getZevanoryProduct('ZEV-LCX-011').pilot_price_brl,197);
  assert.equal(getZevanoryProduct('ZEV-NGC-011').table_price_brl,397);
  for(const item of ZEVANORY_PRODUCTS) assert.match(item.artifact_sha256,/^[a-f0-9]{64}$/);
});

test('public catalog stays non-published and exposes no supplier CPF',()=>{
  const catalog=publicProductCatalog();
  assert.equal(catalog.length,5);
  assert.ok(catalog.every(x=>x.status.includes('not_published')));
  assert.equal(JSON.stringify(catalog).includes('cpf'),false);
});

import { normalizeCheckoutRequest, checkoutReplayDecision, buildAsaasCheckoutPayload } from '../src/order.mjs';
import { buildMercadoPagoPreference } from '../src/mercadopago.mjs';

test('checkout resolves each ZEVANORY SKU to its own pilot price',()=>{
  const prices=new Map([['ZEV-IA-011',147],['ZEV-VEN-011',147],['ZEV-LCX-011',197],['ZEV-CMB-011',247],['ZEV-NGC-011',347]]);
  let n=0;
  for(const [sku,price] of prices){
    const suffix=String(++n).padStart(12,'0');
    const request=normalizeCheckoutRequest({request_id:`123e4567-e89b-42d3-a456-${suffix}`,session_id:`223e4567-e89b-42d3-a456-${suffix}`,offer_id:sku});
    assert.equal(request.offer.id,sku);
    assert.equal(request.offer.price_brl,price);
    const asaas=buildAsaasCheckoutPayload(`323e4567-e89b-42d3-a456-${suffix}`,'https://zevanory.api.br',request.offer);
    assert.equal(asaas.items[0].value,price);
    const mp=buildMercadoPagoPreference(`423e4567-e89b-42d3-a456-${suffix}`,'https://zevanory.api.br',request.offer);
    assert.equal(mp.items[0].id,sku);
    assert.equal(mp.items[0].unit_price,price);
  }
});

test('idempotent replay rejects request reuse across different products',()=>{
  const order={session_id:'123e4567-e89b-42d3-a456-426614174001',offer_id:'ZEV-IA-011',status:'checkout_ready',checkout_url:'https://example.invalid'};
  assert.equal(checkoutReplayDecision(order,order.session_id,'ZEV-CMB-011').action,'offer_conflict');
});


test('all ZEVANORY products are endorsed by ARBM without changing the commercial brand',()=>{
  for(const item of ZEVANORY_PRODUCTS){
    assert.equal(item.brand,'ZEVANORY');
    assert.equal(item.endorsed_by,'ARBM');
    assert.equal(item.brand_signature,'by ARBM');
    assert.match(item.commercial_name,/ - by ARBM$/);
  }
});
