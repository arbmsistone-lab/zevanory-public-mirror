import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler,{verifyResendSignature} from '../src/http/webhookResend.mjs';

const secret='whsec_'+Buffer.from('zevanory-resend-test-key').toString('base64');
const payload=JSON.stringify({type:'email.received',data:{email_id:'mail_123'}});
const ts=String(Math.floor(Date.now()/1000));
const id='msg_123';
const sig=crypto.createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${ts}.${payload}`).digest('base64');

test('Resend webhook signature validates HMAC and timestamp',()=>{
  assert.equal(verifyResendSignature({payload,id,timestamp:ts,signature:`v1,${sig}`,secret}),true);
  assert.equal(verifyResendSignature({payload,id,timestamp:ts,signature:'v1,AAAA',secret}),false);
  assert.equal(verifyResendSignature({payload,id,timestamp:'1',signature:`v1,${sig}`,secret}),false);
});

test('Resend webhook remains fail closed while inbound disabled',async()=>{
  const old={secret:process.env.RESEND_WEBHOOK_SECRET,enabled:process.env.EMAIL_INBOUND_ENABLED};
  process.env.RESEND_WEBHOOK_SECRET=secret;process.env.EMAIL_INBOUND_ENABLED='false';
  const req={method:'POST',body:payload,headers:{'svix-id':id,'svix-timestamp':ts,'svix-signature':`v1,${sig}`}};
  let body='';const res={statusCode:0,setHeader(){},end(v=''){body=v;}};
  await handler(req,res);assert.equal(res.statusCode,503);assert.equal(JSON.parse(body).error,'email_inbound_disabled');
  if(old.secret===undefined)delete process.env.RESEND_WEBHOOK_SECRET;else process.env.RESEND_WEBHOOK_SECRET=old.secret;
  if(old.enabled===undefined)delete process.env.EMAIL_INBOUND_ENABLED;else process.env.EMAIL_INBOUND_ENABLED=old.enabled;
});


test('Resend webhook verifies the exact raw body instead of reserialized JSON',async()=>{
  const rawPayload='{"type": "email.received", "data": {"email_id": "mail_raw"}}';
  const rawTs=String(Math.floor(Date.now()/1000));
  const rawId='msg_raw';
  const rawSig=crypto.createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${rawId}.${rawTs}.${rawPayload}`).digest('base64');
  const old={secret:process.env.RESEND_WEBHOOK_SECRET,enabled:process.env.EMAIL_INBOUND_ENABLED};
  process.env.RESEND_WEBHOOK_SECRET=secret;process.env.EMAIL_INBOUND_ENABLED='false';
  const req={method:'POST',rawBody:Buffer.from(rawPayload),body:JSON.parse(rawPayload),headers:{'svix-id':rawId,'svix-timestamp':rawTs,'svix-signature':`v1,${rawSig}`}};
  let body='';const res={statusCode:0,setHeader(){},end(v=''){body=v;}};
  await handler(req,res);assert.equal(res.statusCode,503);assert.equal(JSON.parse(body).error,'email_inbound_disabled');
  if(old.secret===undefined)delete process.env.RESEND_WEBHOOK_SECRET;else process.env.RESEND_WEBHOOK_SECRET=old.secret;
  if(old.enabled===undefined)delete process.env.EMAIL_INBOUND_ENABLED;else process.env.EMAIL_INBOUND_ENABLED=old.enabled;
});

test('Resend outbound delivery status is processed independently from inbound forwarding gate',async()=>{
  const eventPayload=JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:'mail_out_1'}});
  const eventTs=String(Math.floor(Date.now()/1000)),eventId='msg_delivery';
  const eventSig=crypto.createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${eventId}.${eventTs}.${eventPayload}`).digest('base64');
  const old={secret:process.env.RESEND_WEBHOOK_SECRET,enabled:process.env.EMAIL_INBOUND_ENABLED,database:process.env.DATABASE_URL};
  process.env.RESEND_WEBHOOK_SECRET=secret;process.env.EMAIL_INBOUND_ENABLED='false';delete process.env.DATABASE_URL;
  const req={method:'POST',rawBody:Buffer.from(eventPayload),headers:{'svix-id':eventId,'svix-timestamp':eventTs,'svix-signature':`v1,${eventSig}`}};let body='';const res={statusCode:0,setHeader(){},end(v=''){body=v;}};
  await handler(req,res);assert.equal(res.statusCode,503);assert.equal(JSON.parse(body).error,'confirmation_storage_unavailable');
  for(const [key,value] of Object.entries({RESEND_WEBHOOK_SECRET:old.secret,EMAIL_INBOUND_ENABLED:old.enabled,DATABASE_URL:old.database})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

test('webhook router disables automatic body parsing for signature-safe raw input',async()=>{
  const {config}=await import('../api/webhooks.mjs');
  assert.equal(config?.api?.bodyParser,false);
});

async function runInbound(fetchImpl) {
  const keys=['RESEND_WEBHOOK_SECRET','EMAIL_INBOUND_ENABLED','RESEND_API_KEY','RESEND_FORWARD_TO','RESEND_FROM_ADDRESS'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const oldFetch=globalThis.fetch;
  Object.assign(process.env,{RESEND_WEBHOOK_SECRET:secret,EMAIL_INBOUND_ENABLED:'true',RESEND_API_KEY:'test-only',RESEND_FORWARD_TO:'zevanory@gmail.com',RESEND_FROM_ADDRESS:'contato@zevanory.api.br'});
  globalThis.fetch=fetchImpl;
  try {let body;const res={statusCode:0,setHeader(){},end(v){body=JSON.parse(v);}};await handler({method:'POST',rawBody:payload,headers:{'svix-id':id,'svix-timestamp':ts,'svix-signature':`v1,${sig}`}},res);return {status:res.statusCode,body};}
  finally {globalThis.fetch=oldFetch;for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
const response=body=>({ok:true,status:200,json:async()=>body});
const received={to:['suporte@zevanory.api.br'],from:'controlled@example.com',subject:'controlled test',text:'test'};
test('Resend forwards signed inbound with stable idempotency and auditable IDs',async()=>{
  const keys=[];const fake=async(url,opts)=>{if(opts.method==='GET')return response(received);keys.push(opts.headers['idempotency-key']);return response({id:'forward-test'});};
  for(let i=0;i<2;i++){const r=await runInbound(fake);assert.equal(r.status,200);assert.equal(r.body.forward_email_id,'forward-test');assert.equal(r.body.source_email_id,'mail_123');assert.equal(r.body.delivery_proven,false);}
  assert.deepEqual(keys,['inbound-mail_123','inbound-mail_123']);
});
test('Resend HTTP 200 logical errors and missing send IDs cannot report forwarding',async()=>{
  for(const body of [{error:'rejected'},{name:'validation_error'},{}]){const r=await runInbound(async(url,opts)=>response(opts.method==='GET'?received:body));assert.equal(r.status,503);assert.equal(r.body.accepted,false);}
});
test('Resend does not forward matching aliases from unrelated domains',async()=>{
  let calls=0;const r=await runInbound(async()=>{calls++;return response({...received,to:['suporte@other.example']});});assert.equal(r.body.ignored,true);assert.equal(calls,1);
});
test('Resend transient fetch failure returns retryable status',async()=>{const r=await runInbound(async()=>{throw new Error('network unavailable');});assert.equal(r.status,503);assert.equal(r.body.accepted,false);});
