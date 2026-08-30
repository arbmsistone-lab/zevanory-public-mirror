import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import handler,{createAsaasCheckout} from '../src/http/checkoutAsaas.mjs';

const checkoutSource=await readFile(new URL('../src/http/checkoutAsaas.mjs',import.meta.url),'utf8');

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

test('checkout own switch remains a second-layer gate',()=>{
  const globalPos=checkoutSource.indexOf('sales_globally_blocked');
  const ownPos=checkoutSource.indexOf('checkout_disabled');
  assert.ok(globalPos>=0);
  assert.ok(ownPos>globalPos);
});

test('checkout accepts only explicit Sandbox or Production behind both prior gates',()=>{
  const ownPos=checkoutSource.indexOf('checkout_disabled');
  const envPos=checkoutSource.indexOf('checkout_environment_invalid');
  assert.ok(ownPos>=0);
  assert.ok(envPos>ownPos);
  assert.match(checkoutSource,/\['sandbox','production'\]\.includes\(asaasEnv\)/);
});
