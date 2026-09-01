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
