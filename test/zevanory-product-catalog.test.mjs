import test from 'node:test';
import assert from 'node:assert/strict';
import { ARBM_SIST_OFFER, ZEVANORY_PRODUCTS, ZEVANORY_PORTFOLIO, getZevanoryProduct, publicProductCatalog, resolveCheckoutOffer } from '../src/offerCatalog.mjs';

test('ZEVANORY v2.1 catalog contains the five certified handoff products',()=>{
  assert.equal(ZEVANORY_PRODUCTS.length,5);
  assert.deepEqual(ZEVANORY_PRODUCTS.map(x=>x.sku),['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011','ZEV-CMB-011','ZEV-NGC-011']);
});

test('ARBM SIST is the single primary ZEVANORY product and content bundle stays complementary',()=>{
  const primary=ZEVANORY_PORTFOLIO.filter(x=>x.primary);
  assert.equal(primary.length,1);
  assert.equal(primary[0].id,'OFFER-0001');
  assert.equal(primary[0].product,'ARBM SIST');
  assert.equal(primary[0].brand,'ZEVANORY');
  assert.equal(primary[0].price_brl,1197);
  assert.equal(ARBM_SIST_OFFER.portfolio_role,'primary_product');
  assert.equal(getZevanoryProduct('ZEV-NGC-011').primary,false);
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
  assert.equal(catalog.length,7);
  assert.equal(catalog.filter(x=>x.primary).length,1);
  assert.equal(catalog.find(x=>x.primary).id,'OFFER-0001');
  assert.ok(catalog.every(x=>x.status.includes('not_published')));
  assert.equal(JSON.stringify(catalog).includes('cpf'),false);
});

import { normalizeCheckoutRequest, checkoutReplayDecision, buildAsaasCheckoutPayload } from '../src/order.mjs';
import { buildMercadoPagoPreference } from '../src/mercadopago.mjs';

test('only materialized ZEVANORY products resolve to checkout',()=>{
  const primary=resolveCheckoutOffer();
  assert.equal(primary.id,'OFFER-0001');
  assert.equal(primary.product,'ARBM SIST');
  assert.equal(primary.price_brl,1197);
  for(const sku of ['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011','ZEV-CMB-011','ZEV-NGC-011']) {
    const item=getZevanoryProduct(sku);
    assert.equal(item.sellable,true);
    assert.equal(item.artifact_materialized,true);
    const resolved=resolveCheckoutOffer(sku);
    assert.equal(resolved.id,sku);
    assert.equal(resolved.artifact_sha256,item.artifact_sha256);
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
