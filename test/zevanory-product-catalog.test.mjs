import test from 'node:test';
import assert from 'node:assert/strict';
import { ARBM_SIST_OFFER, ZEVANORY_PRODUCTS, ZEVANORY_PORTFOLIO, getZevanoryProduct, publicProductCatalog, resolveCheckoutOffer } from '../src/offerCatalog.mjs';

test('ZEVANORY catalog contains the five v2.1 Master/Senior content-certified products',()=>{
  assert.equal(ZEVANORY_PRODUCTS.length,5);
  assert.deepEqual(ZEVANORY_PRODUCTS.map(x=>x.sku),['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011','ZEV-CMB-011','ZEV-NGC-011']);
  for(const item of ZEVANORY_PRODUCTS){
    assert.equal(item.version,'2.1');
    assert.equal(item.content_quality_certified,true);
    assert.equal(item.quality_certified,false);
    assert.equal(item.sellable,false);
  }
});

test('ARBM SIST remains the single primary product while content stays complementary',()=>{
  const primary=ZEVANORY_PORTFOLIO.filter(x=>x.primary);
  assert.equal(primary.length,1);
  assert.equal(primary[0].id,'OFFER-0001');
  assert.equal(primary[0].product,'ARBM SIST');
  assert.equal(primary[0].brand,'ZEVANORY');
  assert.equal(primary[0].price_brl,1197);
  assert.equal(ARBM_SIST_OFFER.portfolio_role,'primary_product');
  assert.equal(getZevanoryProduct('ZEV-NGC-011').primary,false);
});

test('content products retain registered prices and immutable v2 artifact hashes',()=>{
  assert.equal(getZevanoryProduct('zev-ia-011').pilot_price_brl,147);
  assert.equal(getZevanoryProduct('ZEV-VEN-011').table_price_brl,197);
  assert.equal(getZevanoryProduct('ZEV-LCX-011').pilot_price_brl,197);
  assert.equal(getZevanoryProduct('ZEV-NGC-011').table_price_brl,397);
  for(const item of ZEVANORY_PRODUCTS) assert.match(item.artifact_sha256,/^[a-f0-9]{64}$/);
});
test('public catalog stays non-published and exposes no supplier CPF',()=>{
  const catalog=publicProductCatalog();
  assert.equal(catalog.length,8);
  assert.equal(catalog.filter(x=>x.primary).length,1);
  assert.equal(catalog.find(x=>x.primary).id,'OFFER-0001');
  assert.ok(catalog.every(x=>x.status.includes('not_published')));
  assert.equal(JSON.stringify(catalog).includes('cpf'),false);
});

import { checkoutReplayDecision } from '../src/order.mjs';

test('quality-certified content products remain blocked from checkout by the global sales gate',()=>{
  const primary=resolveCheckoutOffer();
  assert.equal(primary.id,'OFFER-0001');
  assert.equal(primary.product,'ARBM SIST');
  for(const sku of ['ZEV-IA-011','ZEV-VEN-011','ZEV-LCX-011','ZEV-CMB-011','ZEV-NGC-011']) {
    const item=getZevanoryProduct(sku);
    assert.equal(item.artifact_materialized,true);
    assert.equal(item.sellable,false);
    assert.equal(resolveCheckoutOffer(sku),null);
  }
});

test('idempotent replay rejects request reuse across different products',()=>{
  const order={session_id:'123e4567-e89b-42d3-a456-426614174001',offer_id:'ZEV-IA-011',status:'checkout_ready',checkout_url:'https://example.invalid'};
  assert.equal(checkoutReplayDecision(order,order.session_id,'ZEV-CMB-011').action,'offer_conflict');
});

test('all ZEVANORY content products retain ARBM endorsement and commercial brand',()=>{
  for(const item of ZEVANORY_PRODUCTS){
    assert.equal(item.brand,'ZEVANORY');
    assert.equal(item.endorsed_by,'ARBM');
    assert.equal(item.brand_signature,'by ARBM');
    assert.match(item.commercial_name,/ - by ARBM$/);
  }
});
