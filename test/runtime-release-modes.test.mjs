import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReleaseModes } from '../src/release.mjs';

test('runtime release modes mirror explicit commercial switches',()=>{
  const modes=runtimeReleaseModes({SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',CHECKOUT_ENABLED:'true',FINANCIAL_EVENTS_ENABLED:'true',WHATSAPP_SALES_ENABLED:'false'});
  assert.deepEqual(modes,{salesMode:'globally-blocked',checkoutMode:'enabled',financialMode:'enabled',whatsappMode:'disabled'});
});

test('sales only enables with both global and pre-sale approvals',()=>{
  assert.equal(runtimeReleaseModes({SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'false'}).salesMode,'globally-blocked');
  assert.equal(runtimeReleaseModes({SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'}).salesMode,'enabled');
});
