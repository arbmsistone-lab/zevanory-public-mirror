import test from 'node:test';
import assert from 'node:assert/strict';
import { salesGate, channelEnabled } from '../src/salesGate.mjs';
import configHandler from '../api/config.mjs';

function mock(){
  const headers={};
  return {req:{method:'GET'},res:{statusCode:200,body:'',setHeader(k,v){headers[k]=v;},end(v=''){this.body=v;return this;}}};
}

test('global sales gate is fail-closed by default',()=>{
  assert.equal(salesGate({}).enabled,false);
  assert.equal(salesGate({SALE_GLOBALLY_ENABLED:'true'}).enabled,false);
  assert.equal(salesGate({PRE_SALE_GATES_APPROVED:'true'}).enabled,false);
});

test('canonical pre-sale manifest blocks environment-only activation',()=>{
  const base={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'};
  const gate=salesGate(base);
  assert.equal(gate.enabled,false);
  assert.equal(gate.manifest_approved,false);
  assert.equal(gate.blockers.includes('custom_domain_unverified'),false);
  assert.equal(gate.blockers.includes('asaas_sandbox_unconfigured'),true);
  assert.equal(channelEnabled('WHATSAPP_SALES_ENABLED',{...base,WHATSAPP_SALES_ENABLED:'true'}),false);
});

test('public config exposes no commercial channel while gates are open',()=>{
  const old={sale:process.env.SALE_GLOBALLY_ENABLED,pre:process.env.PRE_SALE_GATES_APPROVED,wa:process.env.WHATSAPP_SALES_ENABLED};
  delete process.env.SALE_GLOBALLY_ENABLED; delete process.env.PRE_SALE_GATES_APPROVED; delete process.env.WHATSAPP_SALES_ENABLED;
  const {req,res}=mock(); configHandler(req,res); const body=JSON.parse(res.body);
  assert.equal(body.commercial_enabled,false);
  assert.equal(body.whatsapp_enabled,false);
  assert.equal(body.whatsapp_number,null);
  assert.equal(body.production_mode,'pre-sale-blocked');
  for(const [k,v] of Object.entries({SALE_GLOBALLY_ENABLED:old.sale,PRE_SALE_GATES_APPROVED:old.pre,WHATSAPP_SALES_ENABLED:old.wa})) {
    if(v===undefined) delete process.env[k]; else process.env[k]=v;
  }
});
