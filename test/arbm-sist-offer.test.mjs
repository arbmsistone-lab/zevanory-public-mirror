import test from 'node:test';
import assert from 'node:assert/strict';
import { ARBM_SIST_OFFER, publicOffer, resolveCheckoutOffer } from '../src/offerCatalog.mjs';
import { digitalFulfillmentReadiness } from '../src/digitalFulfillment.mjs';
import { COMMERCIAL_MODEL, classifyOfferType, revenueRecognitionRule } from '../src/commercialModel.mjs';

test('OFFER-0001 is ARBM SIST digital product with verified artifact',()=>{
  assert.equal(ARBM_SIST_OFFER.id,'OFFER-0001');
  assert.equal(ARBM_SIST_OFFER.product,'ARBM SIST');
  assert.equal(ARBM_SIST_OFFER.version,'10.0.0');
  assert.equal(ARBM_SIST_OFFER.offer_type,'digital_product');
  assert.match(ARBM_SIST_OFFER.artifact_sha256,/^[A-F0-9]{64}$/);
  assert.equal(ARBM_SIST_OFFER.inventory_required,false);
  assert.equal(ARBM_SIST_OFFER.release_state,'technically_certified_unsigned_not_public');
  assert.equal(ARBM_SIST_OFFER.code_signing_required,true);
  assert.equal(ARBM_SIST_OFFER.public_distribution_channel,'microsoft_store_msix');
  assert.equal(ARBM_SIST_OFFER.store_package_sha256,'AD4B7BB91DA10FDA3233019506AC611F7840DFAD89578C9013A48EEAF5A80BB0');
  assert.equal(ARBM_SIST_OFFER.store_submission_ready,false);
  assert.equal(ARBM_SIST_OFFER.code_signing_provider,'microsoft_store_re_signing_after_certification');
  assert.equal(ARBM_SIST_OFFER.direct_unsigned_distribution_allowed,false);
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
  const ready=digitalFulfillmentReadiness({order_status:'paid',payment_confirmed:true,secure_artifact_ref:'vault://arbm-sist/10.0.0'});
  assert.equal(ready.ready,true);
  assert.equal(ready.public_download,false);
});

test('launch channels prioritize proof and owned conversion',()=>{
  assert.deepEqual([...ARBM_SIST_OFFER.primary_channels],['youtube','instagram','whatsapp','zevanory']);
  assert.equal(ARBM_SIST_OFFER.price_brl,1197);
  assert.equal(ARBM_SIST_OFFER.price_status,'commercial_model_defined_release_gated');
});

test('ARBM SIST is the canonical ZEVANORY default paid offer',()=>{
  const active=publicOffer({ARBM_SIST_CODE_SIGNING_READY:'true',ARBM_SIST_PUBLIC_RELEASE_APPROVED:'true'});
  assert.equal(active.id,'OFFER-0001');
  assert.equal(active.product,'ARBM SIST');
  assert.equal(active.version,'10.0.0');
  assert.equal(active.price_brl,1197);
  assert.equal(active.artifact_commercially_releasable,true);
  const arbm=resolveCheckoutOffer();
  assert.equal(arbm.id,'OFFER-0001');
  assert.equal(arbm.product,'ARBM SIST');
  assert.equal(arbm.price_brl,1197);
});

