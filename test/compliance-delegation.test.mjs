import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivationPlan } from '../src/activationPlan.mjs';

const base={
  ACTIVE_OFFER_TYPE:'digital_product',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',
  SUPPORT_CHANNEL:'support@example.com',PAYMENT_PROVIDER:'mercadopago',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',
  PAYMENT_RUNTIME_MODE:'delegated',PAYMENT_RUNTIME_ORIGIN_VERIFIED:'true',
  ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED:'true',ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY:'true',
  COMPLIANCE_RUNTIME_MODE:'delegated',COMPLIANCE_RUNTIME_ORIGIN_VERIFIED:'true',
  COMPLIANCE_RUNTIME_ORIGIN_RELEASE_ID:'ZEVANORY-EG0039-FINAL'
};

test('delegated compliance fails closed for an untrusted origin',()=>{
  const plan=buildActivationPlan({...base,COMPLIANCE_RUNTIME_ORIGIN:'https://example.com'});
  assert.equal(plan.inputs_ready,false);
  assert.ok(plan.missing.some(x=>x.code==='compliance_runtime_origin_unverified'));
  assert.ok(plan.missing.some(x=>x.code==='supplier_tax_id_missing'));
});

test('verified official compliance origin avoids duplicating supplier PII',()=>{
  const plan=buildActivationPlan({...base,COMPLIANCE_RUNTIME_ORIGIN:'https://zevanory.api.br'});
  assert.equal(plan.inputs_ready,true);
  assert.equal(plan.phase,'ready_to_unlock');
  assert.equal(plan.missing.length,0);
});