import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreSaleReadiness } from '../src/preSaleReadiness.mjs';

const dnsAll=[
  {server:'1.1.1.1',address:true},
  {server:'8.8.8.8',address:true},
  {server:'9.9.9.9',address:true},
];

test('pre-sale readiness is blocked by incomplete infrastructure',()=>{
  const r=evaluatePreSaleReadiness({dns:[]});
  assert.equal(r.ready,false);
  assert.equal(r.blockers.includes('custom_domain_dns_unready'),true);
  assert.equal(r.blockers.includes('vercel_ownership_unverified'),true);
  assert.equal(r.blockers.includes('asaas_sandbox_unconfigured'),true);
});

test('pre-sale readiness requires all independent prerequisites',()=>{
  const r=evaluatePreSaleReadiness({
    dns:dnsAll,vercel_txt:true,asaas_key:true,asaas_webhook:true,
    asaas_env_sandbox:true,public_base:true,
  });
  assert.equal(r.ready,true);
  assert.deepEqual(r.blockers,[]);
});
