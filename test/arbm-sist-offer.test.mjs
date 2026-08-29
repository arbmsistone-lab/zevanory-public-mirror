import test from 'node:test';
import assert from 'node:assert/strict';
import { ARBM_SIST_OFFER } from '../src/offerCatalog.mjs';
import { digitalFulfillmentReadiness } from '../src/digitalFulfillment.mjs';
import { COMMERCIAL_MODEL, classifyOfferType, revenueRecognitionRule } from '../src/commercialModel.mjs';

test('OFFER-0001 is ARBM SIST digital product with verified artifact',()=>{
  assert.equal(ARBM_SIST_OFFER.id,'OFFER-0001');
  assert.equal(ARBM_SIST_OFFER.product,'ARBM SIST');
  assert.equal(ARBM_SIST_OFFER.version,'8.1.0');
  assert.equal(ARBM_SIST_OFFER.offer_type,'digital_product');
  assert.match(ARBM_SIST_OFFER.artifact_sha256,/^[A-F0-9]{64}$/);
  assert.equal(ARBM_SIST_OFFER.inventory_required,false);
});

test('digital products are first-party no-inventory authenticated revenue',()=>{
  assert.ok(COMMERCIAL_MODEL.own_offer_types.includes('digital_product'));
  assert.equal(classifyOfferType('digital_product'),'digital_product');
  assert.deepEqual(revenueRecognitionRule('digital_product'),{source:'authenticated_payment',provider:'asaas'});
});
test('digital fulfillment is impossible before reconciled payment and secure artifact',()=>{
  const blocked=digitalFulfillmentReadiness({order_status:'created',payment_confirmed:false});
  assert.equal(blocked.ready,false);
  assert.deepEqual(blocked.blockers,['order_not_paid','payment_not_reconciled','secure_artifact_not_configured']);
  const ready=digitalFulfillmentReadiness({order_status:'paid',payment_confirmed:true,secure_artifact_ref:'vault://arbm-sist/8.1.0'});
  assert.equal(ready.ready,true);
  assert.equal(ready.public_download,false);
});

test('launch channels prioritize proof and owned conversion',()=>{
  assert.deepEqual([...ARBM_SIST_OFFER.primary_channels],['youtube','instagram','whatsapp','zevanory']);
  assert.equal(ARBM_SIST_OFFER.price_brl,497);
  assert.equal(ARBM_SIST_OFFER.price_status,'pilot_hypothesis_not_validated');
});
