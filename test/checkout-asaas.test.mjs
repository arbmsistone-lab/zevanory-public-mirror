import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler,{createAsaasCheckout} from '../api/checkout/asaas.mjs';

function mockReq(body={},method='POST'){ return {body,method,headers:{}}; }
function mockRes(){
  const headers={};
  return {statusCode:200,body:'',setHeader(k,v){headers[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers};
}

function restore(name,value){
  if(value===undefined) delete process.env[name]; else process.env[name]=value;
}

test('Asaas checkout creation uses Sandbox API and access_token',async()=>{
  let seen;
  const payload={externalReference:'ZEVANORY:EXP-0001:test'};
  const result=await createAsaasCheckout(payload,'sandbox-key',async(url,opts)=>{
    seen={url,opts};
    return {ok:true,json:async()=>({id:'550e8400-e29b-41d4-a716-446655440000'})};
  });
  assert.match(seen.url,/api-sandbox\.asaas\.com\/v3\/checkouts$/);
  assert.equal(seen.opts.headers.access_token,'sandbox-key');
  assert.equal(JSON.parse(seen.opts.body).externalReference,payload.externalReference);
  assert.equal(result.id,'550e8400-e29b-41d4-a716-446655440000');
});
test('checkout endpoint is globally blocked by default',async()=>{
  const old={sale:process.env.SALE_GLOBALLY_ENABLED,pre:process.env.PRE_SALE_GATES_APPROVED,enabled:process.env.CHECKOUT_ENABLED,env:process.env.ASAAS_ENV};
  delete process.env.SALE_GLOBALLY_ENABLED; delete process.env.PRE_SALE_GATES_APPROVED;
  process.env.CHECKOUT_ENABLED='true'; process.env.ASAAS_ENV='sandbox';
  const res=mockRes();
  await handler(mockReq({request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),res);
  assert.equal(res.statusCode,503);
  assert.match(res.body,/sales_globally_blocked/);
  restore('SALE_GLOBALLY_ENABLED',old.sale); restore('PRE_SALE_GATES_APPROVED',old.pre); restore('CHECKOUT_ENABLED',old.enabled); restore('ASAAS_ENV',old.env);
});

test('checkout own switch remains required after global approval',async()=>{
  const old={sale:process.env.SALE_GLOBALLY_ENABLED,pre:process.env.PRE_SALE_GATES_APPROVED,enabled:process.env.CHECKOUT_ENABLED,env:process.env.ASAAS_ENV};
  process.env.SALE_GLOBALLY_ENABLED='true'; process.env.PRE_SALE_GATES_APPROVED='true'; delete process.env.CHECKOUT_ENABLED; process.env.ASAAS_ENV='sandbox';
  const res=mockRes();
  await handler(mockReq({request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),res);
  assert.equal(res.statusCode,503);
  assert.match(res.body,/checkout_disabled/);
  restore('SALE_GLOBALLY_ENABLED',old.sale); restore('PRE_SALE_GATES_APPROVED',old.pre); restore('CHECKOUT_ENABLED',old.enabled); restore('ASAAS_ENV',old.env);
});

test('checkout endpoint remains Sandbox-only after all sale gates',async()=>{
  const old={sale:process.env.SALE_GLOBALLY_ENABLED,pre:process.env.PRE_SALE_GATES_APPROVED,enabled:process.env.CHECKOUT_ENABLED,env:process.env.ASAAS_ENV};
  process.env.SALE_GLOBALLY_ENABLED='true'; process.env.PRE_SALE_GATES_APPROVED='true'; process.env.CHECKOUT_ENABLED='true';
  process.env.ASAAS_ENV='production';
  const res=mockRes();
  await handler(mockReq({request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),res);
  assert.equal(res.statusCode,503);
  assert.match(res.body,/checkout_sandbox_only/);
  restore('SALE_GLOBALLY_ENABLED',old.sale); restore('PRE_SALE_GATES_APPROVED',old.pre); restore('CHECKOUT_ENABLED',old.enabled); restore('ASAAS_ENV',old.env);
});
