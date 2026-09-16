import test from 'node:test';
import assert from 'node:assert/strict';
import { ARBM_ONE_OFFER } from '../src/arbmOneOffer.mjs';
import { publicProductCatalog, resolveCheckoutOffer } from '../src/offerCatalog.mjs';

test('ARBM ONE pricing is synchronized with approved commercial policy',()=>{
  assert.equal(ARBM_ONE_OFFER.pricing.standard_monthly_brl,697);
  assert.equal(ARBM_ONE_OFFER.pricing.standard_implementation_brl,1490);
  assert.equal(ARBM_ONE_OFFER.pricing.annual_brl,6970);
  assert.equal(ARBM_ONE_OFFER.pricing.enterprise_monthly_from_brl,1197);
  assert.equal(ARBM_ONE_OFFER.pricing.enterprise_implementation_from_brl,2490);
  assert.equal(ARBM_ONE_OFFER.founder_program.monthly_brl,497);
  assert.equal(ARBM_ONE_OFFER.founder_program.implementation_brl,990);
  assert.equal(ARBM_ONE_OFFER.founder_program.customer_limit,5);
  assert.equal(ARBM_ONE_OFFER.founder_program.price_protection_months,12);
});

test('ARBM ONE remains sales locked and founder pricing stays private',()=>{
  assert.equal(ARBM_ONE_OFFER.sellable,false);
  assert.equal(ARBM_ONE_OFFER.checkout_enabled,false);
  assert.equal(resolveCheckoutOffer('ARBM-ONE'),null);
  const publicItem=publicProductCatalog().find(item=>item.id==='ARBM-ONE');
  assert.ok(publicItem);
  assert.equal('founder_program' in publicItem,false);
  assert.equal(publicItem.status,'commercial_model_defined_sales_locked_not_published');
});
