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

test('service can become ready without enabling sales',()=>{
  const env={ACTIVE_OFFER_TYPE:'service',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',ASAAS_ENV:'production',ASAAS_API_KEY:'secret',ASAAS_WEBHOOK_TOKEN:'secret',SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false'};
  const plan=buildActivationPlan(env);
  assert.equal(plan.inputs_ready,true);
  assert.equal(plan.phase,'ready_to_unlock');
  assert.equal(plan.commercial_enabled,false);
});
test('affiliate readiness remains inventory-free and requires provider evidence',()=>{
  const env={ACTIVE_OFFER_TYPE:'affiliate_product',OFFER_SELECTION_APPROVED:'true',SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',SUPPORT_CHANNEL:'support@example.com',AFFILIATE_PROVIDER:'network',AFFILIATE_TRACKING_READY:'true',AFFILIATE_TERMS_REVIEWED:'true'};
  const plan=buildActivationPlan(env);
  assert.equal(plan.inputs_ready,true);
  assert.equal(plan.inventory_required,false);
});

test('cutover and rollback preserve fail-closed ordering',()=>{
  assert.ok(CUTOVER_ORDER.indexOf('PRE_SALE_GATES_APPROVED=true')<CUTOVER_ORDER.indexOf('SALE_GLOBALLY_ENABLED=true'));
  assert.equal(ROLLBACK_ORDER[0],'SALE_GLOBALLY_ENABLED=false');
  for(const step of ['CHECKOUT_ENABLED=false','WHATSAPP_SALES_ENABLED=false','FINANCIAL_EVENTS_ENABLED=false','PRE_SALE_GATES_APPROVED=false']) assert.ok(ROLLBACK_ORDER.includes(step));
});
