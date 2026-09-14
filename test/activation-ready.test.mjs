import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivationPlan, CUTOVER_ORDER, ROLLBACK_ORDER } from '../src/activationPlan.mjs';

test('activation plan exposes external blockers without secrets',()=>{
  const plan=buildActivationPlan({});
  assert.equal(plan.phase,'waiting_external_inputs');
  assert.equal(plan.inputs_ready,false);
  assert.equal(plan.commercial_enabled,false);
  assert.ok(plan.missing.some(x=>x.code==='supplier_legal_name_missing'));
  assert.ok(plan.missing.every(x=>!('value' in x)));
});

test('payment credentials cannot bypass merchant identity verification',()=>{
  const env={ACTIVE_OFFER_TYPE:'digital_product',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',PAYMENT_PROVIDER:'mercadopago',MERCADOPAGO_ENV:'production',MERCADOPAGO_ACCESS_TOKEN:'secret',MERCADOPAGO_WEBHOOK_SECRET:'secret'};
  const plan=buildActivationPlan(env);
  assert.equal(plan.inputs_ready,false);
  assert.ok(plan.missing.some(x=>x.code==='payment_merchant_identity_unverified'));
});

test('service inputs can become ready after technical lifecycle certification while commercial gates stay closed',()=>{
  const env={ACTIVE_OFFER_TYPE:'service',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',PAYMENT_PROVIDER:'asaas',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',ASAAS_ENV:'production',ASAAS_API_KEY:'secret',ASAAS_WEBHOOK_TOKEN:'secret',SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false'};
  const plan=buildActivationPlan(env);
  assert.equal(plan.inputs_ready,true);
  assert.equal(plan.phase,'ready_to_unlock');
  assert.equal(plan.commercial_enabled,false);
  assert.equal(plan.lifecycle.approved,true);
});
test('affiliate readiness remains inventory-free and requires provider evidence',()=>{
  const env={ACTIVE_OFFER_TYPE:'affiliate_product',OFFER_SELECTION_APPROVED:'true',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',AFFILIATE_PROVIDER:'network',AFFILIATE_WEBHOOK_URL:'https://affiliate.example/webhook',AFFILIATE_WEBHOOK_TOKEN:'token',AFFILIATE_TRACKING_READY:'true',AFFILIATE_TERMS_REVIEWED:'true',AFFILIATE_TERMS_VERSION:'v1',AFFILIATE_ATTRIBUTION_WINDOW_DAYS:'30',AFFILIATE_COMMISSION_BPS:'1000',AFFILIATE_PAYOUT_DELAY_DAYS:'30',AFFILIATE_SELF_REFERRAL_POLICY:'blocked',AFFILIATE_REFUND_REVERSAL_READY:'true',AFFILIATE_CHARGEBACK_REVERSAL_READY:'true',AFFILIATE_IDEMPOTENCY_READY:'true',AFFILIATE_PROVIDER_CONFIRMATION_READY:'true',AFFILIATE_DISCLOSURE_URL:'https://zevanory.api.br/afiliados',AFFILIATE_PRIVACY_URL:'https://zevanory.api.br/politica-de-privacidade'};
  const plan=buildActivationPlan(env);
  assert.equal(plan.inputs_ready,true);
  assert.equal(plan.inventory_required,false);
});

test('cutover and rollback preserve fail-closed ordering',()=>{
  assert.ok(CUTOVER_ORDER.indexOf('prepare_controlled_certification_pilot_with_global_sales_false')<CUTOVER_ORDER.indexOf('certify_sales_lifecycle_39x10'));
  assert.ok(CUTOVER_ORDER.indexOf('certify_sales_lifecycle_39x10')<CUTOVER_ORDER.indexOf('PRE_SALE_GATES_APPROVED=true'));
  assert.ok(CUTOVER_ORDER.indexOf('PRE_SALE_GATES_APPROVED=true')<CUTOVER_ORDER.indexOf('SALE_GLOBALLY_ENABLED=true'));
  assert.equal(ROLLBACK_ORDER[0],'SALE_GLOBALLY_ENABLED=false');
  for(const step of ['CHECKOUT_ENABLED=false','WHATSAPP_SALES_ENABLED=false','FINANCIAL_EVENTS_ENABLED=false','PRE_SALE_GATES_APPROVED=false']) assert.ok(ROLLBACK_ORDER.includes(step));
});

import configHandler from '../api/config.mjs';

function invokeConfig(url,env={}){
  const previous={...process.env}; Object.assign(process.env,env);
  let body=''; const headers={};
  const res={statusCode:0,setHeader:(k,v)=>{headers[k]=v},end:(v)=>{body=String(v||'')}};
  try { configHandler({method:'GET',url},res); return {status:res.statusCode,body:JSON.parse(body),headers}; }
  finally { process.env=previous; }
}

test('shared config function serves activation readiness without secret values',()=>{
  const r=invokeConfig('/api/config?view=activation',{SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',ACTIVE_OFFER_TYPE:'service',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',PAYMENT_PROVIDER:'asaas',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',ASAAS_ENV:'production',ASAAS_API_KEY:'top-secret',ASAAS_WEBHOOK_TOKEN:'also-secret'});
  assert.equal(r.status,200); assert.equal(r.body.inputs_ready,true); assert.equal(r.body.commercial_enabled,false);
  const text=JSON.stringify(r.body); assert.equal(text.includes('top-secret'),false); assert.equal(text.includes('also-secret'),false);
});

test('ARBM SIST digital product requires signing and explicit public release approval',()=>{
  const base={ACTIVE_OFFER_TYPE:'digital_product',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',PAYMENT_PROVIDER:'mercadopago',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',MERCADOPAGO_ENV:'production',MERCADOPAGO_ACCESS_TOKEN:'secret',MERCADOPAGO_WEBHOOK_SECRET:'secret'};
  const blocked=buildActivationPlan(base);
  assert.equal(blocked.inputs_ready,false);
  assert.ok(blocked.missing.some(x=>x.code==='arbm_sist_code_signing_not_ready'));
  assert.ok(blocked.missing.some(x=>x.code==='arbm_sist_public_release_not_approved'));
  const ready=buildActivationPlan({...base,ARBM_SIST_CODE_SIGNING_READY:'true',ARBM_SIST_PUBLIC_RELEASE_APPROVED:'true',SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false'});
  assert.equal(ready.inputs_ready,true);
  assert.equal(ready.commercial_enabled,false);
  assert.equal(ready.phase,'ready_to_unlock');
  assert.equal(ready.lifecycle.approved,true);
});

test('ARBM SIST signing alone never bypasses explicit public release approval',()=>{
  const env={ACTIVE_OFFER_TYPE:'digital_product',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',PAYMENT_PROVIDER:'mercadopago',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',MERCADOPAGO_ENV:'production',MERCADOPAGO_ACCESS_TOKEN:'secret',MERCADOPAGO_WEBHOOK_SECRET:'secret',ARBM_SIST_CODE_SIGNING_READY:'true'};
  const plan=buildActivationPlan(env);
  assert.equal(plan.inputs_ready,false);
  assert.ok(plan.missing.some(x=>x.code==='arbm_sist_public_release_not_approved'));
});
