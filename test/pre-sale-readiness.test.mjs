import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreSaleReadiness } from '../src/preSaleReadiness.mjs';

const dnsAll=[{server:'1.1.1.1',address:true},{server:'8.8.8.8',address:true},{server:'9.9.9.9',address:true}];
const safe={database_url:true,public_base_https:true,sale_globally_enabled:false,pre_sale_gates_approved:false,checkout_enabled:false,whatsapp_sales_enabled:false,financial_events_enabled:false};
const base={dns:dnsAll,domain_ownership_verified:true,https_ready:true,routes_ready:true,...safe};

test('pre-sale readiness is blocked by incomplete infrastructure with generic blockers',()=>{
  const r=evaluatePreSaleReadiness({dns:[]});
  assert.equal(r.ready,false);
  for(const code of ['custom_domain_dns_unready','domain_ownership_unverified','custom_domain_https_unready','custom_domain_routes_unready','payment_sandbox_capacity_unavailable'])assert.ok(r.blockers.includes(code));
});

test('generic qualified sandbox payment capacity satisfies payment prerequisite',()=>{
  const r=evaluatePreSaleReadiness({...base,payment_capacity_ready:true});
  assert.equal(r.ready,true);assert.equal(r.payment_ready,true);assert.equal(r.payment_capacity_ready,true);assert.deepEqual(r.blockers,[]);
});

test('provider adapters can satisfy payment capacity without selecting a primary',()=>{
  const asaas=evaluatePreSaleReadiness({...base,asaas_key:true,asaas_webhook:true,asaas_env_sandbox:true});
  const mp=evaluatePreSaleReadiness({...base,mercadopago_token:true,mercadopago_webhook:true,mercadopago_env_sandbox:true});
  assert.equal(asaas.ready,true);assert.equal(asaas.asaas_ready,true);
  assert.equal(mp.ready,true);assert.equal(mp.mercadopago_ready,true);
});
test('domain HTTPS routes storage and safe flags remain mandatory',()=>{
  const ready={...base,payment_capacity_ready:true};
  assert.ok(evaluatePreSaleReadiness({...ready,https_ready:false}).blockers.includes('custom_domain_https_unready'));
  assert.ok(evaluatePreSaleReadiness({...ready,routes_ready:false}).blockers.includes('custom_domain_routes_unready'));
  assert.equal(evaluatePreSaleReadiness({...ready,database_url:false}).payment_ready,false);
  assert.equal(evaluatePreSaleReadiness({...ready,public_base_https:false}).payment_ready,false);
  for(const key of ['sale_globally_enabled','pre_sale_gates_approved','checkout_enabled','whatsapp_sales_enabled','financial_events_enabled']){
    const r=evaluatePreSaleReadiness({...ready,[key]:true});
    assert.equal(r.ready,false,key);assert.equal(r.commercial_flags_safe,false,key);assert.ok(r.blockers.includes('payment_sandbox_capacity_unavailable'),key);
  }
});

test('legacy current-provider domain claim is compatibility evidence, never a named core requirement',()=>{
  const r=evaluatePreSaleReadiness({...base,domain_ownership_verified:false,legacy_domain_claim_verified:true,payment_capacity_ready:true});
  assert.equal(r.ownership_ready,true);assert.equal(r.ready,true);
});
