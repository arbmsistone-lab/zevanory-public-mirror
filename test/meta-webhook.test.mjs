import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../src/http/webhookMeta.mjs';

const response=()=>{let body='';return {res:{statusCode:0,setHeader(){},end(v=''){body=String(v);return this;}},body:()=>body};};

test('Meta webhook verification requires exact configured token',async()=>{
  const old=process.env.META_WEBHOOK_VERIFY_TOKEN;process.env.META_WEBHOOK_VERIFY_TOKEN='verify-123';
  try{
    const ok=response();await handler({method:'GET',query:{'hub.mode':'subscribe','hub.verify_token':'verify-123','hub.challenge':'abc'}},ok.res);assert.equal(ok.res.statusCode,200);assert.equal(ok.body(),'abc');
    const bad=response();await handler({method:'GET',query:{'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'abc'}},bad.res);assert.equal(bad.res.statusCode,403);
  }finally{if(old===undefined)delete process.env.META_WEBHOOK_VERIFY_TOKEN;else process.env.META_WEBHOOK_VERIFY_TOKEN=old;}
});

test('Meta webhook rejects unsigned status payload before storage',async()=>{
  const old=process.env.META_APP_SECRET;process.env.META_APP_SECRET='secret';
  try{const x=response();await handler({method:'POST',rawBody:Buffer.from('{"object":"whatsapp_business_account"}'),headers:{}},x.res);assert.equal(x.res.statusCode,401);assert.equal(JSON.parse(x.body()).error,'webhook_auth_failed');}
  finally{if(old===undefined)delete process.env.META_APP_SECRET;else process.env.META_APP_SECRET=old;}
});
