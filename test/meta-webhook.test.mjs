import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../src/http/webhookMeta.mjs';

const response=()=>{let body='';return {res:{statusCode:0,setHeader(){},end(v=''){body=String(v);return this;}},body:()=>body};};
const runVerify=async(token)=>{const x=response();await handler({method:'GET',query:{'hub.mode':'subscribe','hub.verify_token':token,'hub.challenge':'abc'}},x.res);return x;};

test('Meta webhook verification prefers canonical META_VERIFY_TOKEN',async()=>{
  const oldA=process.env.META_VERIFY_TOKEN,oldB=process.env.META_WEBHOOK_VERIFY_TOKEN;process.env.META_VERIFY_TOKEN='verify-new';process.env.META_WEBHOOK_VERIFY_TOKEN='verify-old';
  try{const ok=await runVerify('verify-new');assert.equal(ok.res.statusCode,200);assert.equal(ok.body(),'abc');const old=await runVerify('verify-old');assert.equal(old.res.statusCode,403);}
  finally{oldA===undefined?delete process.env.META_VERIFY_TOKEN:process.env.META_VERIFY_TOKEN=oldA;oldB===undefined?delete process.env.META_WEBHOOK_VERIFY_TOKEN:process.env.META_WEBHOOK_VERIFY_TOKEN=oldB;}
});

test('Meta webhook keeps legacy verify-token fallback',async()=>{
  const oldA=process.env.META_VERIFY_TOKEN,oldB=process.env.META_WEBHOOK_VERIFY_TOKEN;delete process.env.META_VERIFY_TOKEN;process.env.META_WEBHOOK_VERIFY_TOKEN='legacy';
  try{const ok=await runVerify('legacy');assert.equal(ok.res.statusCode,200);const bad=await runVerify('wrong');assert.equal(bad.res.statusCode,403);}
  finally{oldA===undefined?delete process.env.META_VERIFY_TOKEN:process.env.META_VERIFY_TOKEN=oldA;oldB===undefined?delete process.env.META_WEBHOOK_VERIFY_TOKEN:process.env.META_WEBHOOK_VERIFY_TOKEN=oldB;}
});

test('Meta webhook rejects unsigned status payload before storage',async()=>{const old=process.env.META_APP_SECRET;process.env.META_APP_SECRET='secret';try{const x=response();await handler({method:'POST',rawBody:Buffer.from('{"object":"whatsapp_business_account"}'),headers:{}},x.res);assert.equal(x.res.statusCode,401);}finally{old===undefined?delete process.env.META_APP_SECRET:process.env.META_APP_SECRET=old;}});
