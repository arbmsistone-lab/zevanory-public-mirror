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

test('channel requires global gate plus its own explicit flag',()=>{
  const base={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'};
  assert.equal(salesGate(base).enabled,true);
  assert.equal(channelEnabled('WHATSAPP_SALES_ENABLED',base),false);
  assert.equal(channelEnabled('WHATSAPP_SALES_ENABLED',{...base,WHATSAPP_SALES_ENABLED:'true'}),true);
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
