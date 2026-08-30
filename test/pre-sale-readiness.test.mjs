import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreSaleReadiness } from '../src/preSaleReadiness.mjs';

const dnsAll=[{server:'1.1.1.1',address:true},{server:'8.8.8.8',address:true},{server:'9.9.9.9',address:true}];
const safe={database_url:true,public_base_https:true,sale_globally_enabled:false,pre_sale_gates_approved:false,checkout_enabled:false,whatsapp_sales_enabled:false,financial_events_enabled:false};
const asaas={payment_provider:'asaas',asaas_key:true,asaas_webhook:true,asaas_env_sandbox:true,...safe};
const mp={payment_provider:'mercadopago',mercadopago_token:true,mercadopago_webhook:true,mercadopago_env_sandbox:true,...safe};

test('pre-sale readiness is blocked by incomplete infrastructure',()=>{
  const r=evaluatePreSaleReadiness({dns:[]});
  assert.equal(r.ready,false); for(const code of ['custom_domain_dns_unready','vercel_ownership_unverified','custom_domain_https_unready','custom_domain_routes_unready','payment_provider_not_selected']) assert.ok(r.blockers.includes(code));
});

test('Asaas sandbox can satisfy independent payment prerequisite',()=>{
  const r=evaluatePreSaleReadiness({dns:dnsAll,vercel_txt:true,https_ready:true,routes_ready:true,...asaas});
  assert.equal(r.ready,true); assert.equal(r.payment_ready,true); assert.equal(r.asaas_ready,true); assert.deepEqual(r.blockers,[]);
});

test('Mercado Pago sandbox can satisfy independent payment prerequisite',()=>{
  const r=evaluatePreSaleReadiness({dns:dnsAll,vercel_txt:true,https_ready:true,routes_ready:true,...mp});
  assert.equal(r.ready,true); assert.equal(r.payment_ready,true); assert.equal(r.mercadopago_ready,true); assert.deepEqual(r.blockers,[]);
});

test('domain HTTPS and routes remain mandatory',()=>{
  const base={dns:dnsAll,vercel_txt:true,...mp};
  assert.ok(evaluatePreSaleReadiness({...base,https_ready:false,routes_ready:true}).blockers.includes('custom_domain_https_unready'));
  assert.ok(evaluatePreSaleReadiness({...base,https_ready:true,routes_ready:false}).blockers.includes('custom_domain_routes_unready'));
});

test('selected provider requires database public base credentials and safe flags',()=>{
  const base={dns:dnsAll,vercel_txt:true,https_ready:true,routes_ready:true,...mp};
  assert.equal(evaluatePreSaleReadiness({...base,database_url:false}).payment_ready,false);
  assert.equal(evaluatePreSaleReadiness({...base,public_base_https:false}).payment_ready,false);
  for(const key of ['sale_globally_enabled','pre_sale_gates_approved','checkout_enabled','whatsapp_sales_enabled','financial_events_enabled']){
    const r=evaluatePreSaleReadiness({...base,[key]:true}); assert.equal(r.ready,false,key); assert.equal(r.payment_ready,false,key); assert.equal(r.commercial_flags_safe,false,key); assert.ok(r.blockers.includes('mercadopago_sandbox_unconfigured'),key);
  }
});