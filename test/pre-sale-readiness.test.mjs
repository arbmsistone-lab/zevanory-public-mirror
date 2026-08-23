import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreSaleReadiness } from '../src/preSaleReadiness.mjs';

const dnsAll=[
  {server:'1.1.1.1',address:true},
  {server:'8.8.8.8',address:true},
  {server:'9.9.9.9',address:true},
];

const sandboxSafe={
  asaas_key:true,
  asaas_webhook:true,
  asaas_env_sandbox:true,
  database_url:true,
  public_base_https:true,
  sale_globally_enabled:false,
  pre_sale_gates_approved:false,
  checkout_enabled:false,
  whatsapp_sales_enabled:false,
  financial_events_enabled:false,
};

test('pre-sale readiness is blocked by incomplete infrastructure',()=>{
  const r=evaluatePreSaleReadiness({dns:[]});
  assert.equal(r.ready,false);
  assert.equal(r.blockers.includes('custom_domain_dns_unready'),true);
  assert.equal(r.blockers.includes('vercel_ownership_unverified'),true);
  assert.equal(r.blockers.includes('custom_domain_https_unready'),true);
  assert.equal(r.blockers.includes('custom_domain_routes_unready'),true);  assert.equal(r.blockers.includes('asaas_sandbox_unconfigured'),true);
});

test('pre-sale readiness requires all independent prerequisites',()=>{
  const r=evaluatePreSaleReadiness({
    dns:dnsAll,vercel_txt:true,https_ready:true,routes_ready:true,...sandboxSafe,
  });
  assert.equal(r.ready,true);
  assert.equal(r.commercial_flags_safe,true);
  assert.deepEqual(r.blockers,[]);
});

test('domain HTTPS and routes are mandatory even after DNS and ownership',()=>{
  const base={dns:dnsAll,vercel_txt:true,...sandboxSafe};
  const noHttps=evaluatePreSaleReadiness({...base,https_ready:false,routes_ready:true});
  assert.equal(noHttps.ready,false);
  assert.equal(noHttps.blockers.includes('custom_domain_https_unready'),true);
  const noRoutes=evaluatePreSaleReadiness({...base,https_ready:true,routes_ready:false});
  assert.equal(noRoutes.ready,false);
  assert.equal(noRoutes.blockers.includes('custom_domain_routes_unready'),true);
});

test('Asaas sandbox requires database and an HTTPS public base',()=>{
  const base={dns:dnsAll,vercel_txt:true,https_ready:true,routes_ready:true,...sandboxSafe};
  const noDatabase=evaluatePreSaleReadiness({...base,database_url:false});
  assert.equal(noDatabase.asaas_ready,false);
  assert.equal(noDatabase.ready,false);
  const noHttpsBase=evaluatePreSaleReadiness({...base,public_base_https:false});
  assert.equal(noHttpsBase.asaas_ready,false);
  assert.equal(noHttpsBase.ready,false);
});
test('Asaas sandbox preparation blocks if any commercial or financial flag is enabled',()=>{
  const base={dns:dnsAll,vercel_txt:true,https_ready:true,routes_ready:true,...sandboxSafe};
  for(const key of [
    'sale_globally_enabled',
    'pre_sale_gates_approved',
    'checkout_enabled',
    'whatsapp_sales_enabled',
    'financial_events_enabled',
  ]) {
    const r=evaluatePreSaleReadiness({...base,[key]:true});
    assert.equal(r.ready,false,key);
    assert.equal(r.asaas_ready,false,key);
    assert.equal(r.commercial_flags_safe,false,key);
    assert.equal(r.blockers.includes('asaas_sandbox_unconfigured'),true,key);
  }
});
