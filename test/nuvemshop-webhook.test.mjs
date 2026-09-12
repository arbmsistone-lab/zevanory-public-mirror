import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyNuvemshopWebhook, applyNuvemshopLifecycleEvent } from '../src/http/webhookNuvemshop.mjs';
import { ensureNuvemshopWebhooks, NUVEMSHOP_REQUIRED_WEBHOOKS, NUVEMSHOP_WEBHOOK_URI } from '../src/nuvemshopOAuth.mjs';

const secret='test-secret';

test('Nuvemshop webhook HMAC accepts exact raw body and rejects tampering',()=>{
  const raw=Buffer.from(JSON.stringify({store_id:123,event:'app/uninstalled',id:41672}));
  const signature=createHmac('sha256',secret).update(raw).digest('hex');
  assert.equal(verifyNuvemshopWebhook(raw,signature,secret),true);
  assert.equal(verifyNuvemshopWebhook(Buffer.from(raw.toString()+' '),signature,secret),false);
  assert.equal(verifyNuvemshopWebhook(raw,'bad',secret),false);
});

test('Nuvemshop lifecycle revokes stored credential fail-closed on uninstall',async()=>{
  let args;const sql={query:async(text,a)=>{assert.match(text,/delete from provider_oauth_credentials/);args=a;return [{account_id:'123'}];}};
  const out=await applyNuvemshopLifecycleEvent(sql,{store_id:123,event:'app/uninstalled'});
  assert.deepEqual(args,['123']);assert.equal(out.credential_revoked,true);
});

test('Nuvemshop non-lifecycle events do not mutate credential',async()=>{
  let calls=0;const out=await applyNuvemshopLifecycleEvent({query:async()=>{calls++;return[];}},{store_id:123,event:'product/created'});
  assert.equal(calls,0);assert.equal(out.credential_revoked,false);
});

test('Nuvemshop OAuth provisions every required webhook once',async()=>{
  const calls=[];const existing=[{event:'app/uninstalled',url:NUVEMSHOP_WEBHOOK_URI}];
  const fetchImpl=async(url,options={})=>{calls.push({url:String(url),method:options.method||'GET',body:options.body||''});if(!options.method)return new Response(JSON.stringify(existing),{status:200,headers:{'content-type':'application/json'}});existing.push(JSON.parse(options.body));return new Response(JSON.stringify({id:calls.length}),{status:201,headers:{'content-type':'application/json'}});};
  const out=await ensureNuvemshopWebhooks({token:{access_token:'token',user_id:123},env:{NUVEMSHOP_APP_ID:'41672'},fetchImpl});
  assert.equal(out.ready,true);assert.equal(out.verified,true);assert.equal(out.required.length,NUVEMSHOP_REQUIRED_WEBHOOKS.length);
  assert.equal(out.created.length,NUVEMSHOP_REQUIRED_WEBHOOKS.length-1);
  assert.equal(calls.filter(x=>x.method==='POST').length,NUVEMSHOP_REQUIRED_WEBHOOKS.length-1);
  const second=await ensureNuvemshopWebhooks({token:{access_token:'token',user_id:123},env:{NUVEMSHOP_APP_ID:'41672'},fetchImpl});assert.equal(second.created.length,0);assert.equal(calls.filter(x=>x.method==='POST').length,NUVEMSHOP_REQUIRED_WEBHOOKS.length-1);
  for(const c of calls.filter(x=>x.method==='POST'))assert.equal(JSON.parse(c.body).url,NUVEMSHOP_WEBHOOK_URI);
});

test('Nuvemshop webhook provisioning fails closed on provider rejection',async()=>{
  const fetchImpl=async(url,options={})=>!options.method?new Response('[]',{status:200}):new Response('{}',{status:422});
  await assert.rejects(()=>ensureNuvemshopWebhooks({token:{access_token:'token',user_id:123},env:{NUVEMSHOP_APP_ID:'41672'},fetchImpl}),/nuvemshop_webhook_create_/);
});

test('Nuvemshop does not report ready when successful create responses are absent from the provider list',async()=>{await assert.rejects(ensureNuvemshopWebhooks({token:{access_token:'token',user_id:123},env:{NUVEMSHOP_APP_ID:'41672'},fetchImpl:async(url,options)=>new Response(options.method?'{}':'[]',{status:options.method?201:200})}),/required_webhooks_not_verified/);});
