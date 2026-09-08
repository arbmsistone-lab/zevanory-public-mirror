import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {normalizeWhatsappStatusPayload,normalizeResendDeliveryEvent,applyProviderConfirmation,confirmationOutcome} from '../src/providerConfirmation.mjs';
import {verifyMetaSignature} from '../src/http/webhookMeta.mjs';

test('WhatsApp normalizes authenticated delivery statuses with provider id',()=>{
  const rows=normalizeWhatsappStatusPayload({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{statuses:[{id:'wamid.1',status:'delivered',timestamp:'1788260000'}]}}]}]});
  assert.equal(rows.length,1);assert.equal(rows[0].provider_message_id,'wamid.1');assert.equal(rows[0].status,'delivered');assert.equal(rows[0].destination,'channel:whatsapp');
});

test('unsupported WhatsApp events never become confirmations',()=>{
  assert.deepEqual(normalizeWhatsappStatusPayload({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{messages:[{id:'wamid.1'}]}}]}]}),[]);
});

test('Resend delivery events distinguish success and terminal failure',()=>{
  const delivered=normalizeResendDeliveryEvent({type:'email.delivered',created_at:'2026-09-01T12:00:00Z',data:{email_id:'mail_1'}});
  const bounced=normalizeResendDeliveryEvent({type:'email.bounced',created_at:'2026-09-01T12:01:00Z',data:{email_id:'mail_1'}});
  assert.equal(delivered.status,'delivered');assert.equal(confirmationOutcome(delivered.status),'confirmed');assert.equal(confirmationOutcome(bounced.status),'failed');
});

test('Meta webhook signature is HMAC-SHA256 over exact raw payload',()=>{
  const payload='{"object":"whatsapp_business_account"}',secret='meta-secret';
  const signature='sha256='+crypto.createHmac('sha256',secret).update(payload).digest('hex');
  assert.equal(verifyMetaSignature({payload,signature,appSecret:secret}),true);
  assert.equal(verifyMetaSignature({payload,signature:'sha256=00',appSecret:secret}),false);
});
test('confirmation persistence is monotonic and updates the same live action plan',async()=>{
  const calls=[];
  const sql={query:async(q,a)=>{calls.push({q:String(q),a});return calls.length===1?[{event_id:'evt1',run_id:'run1',headers:{}}]:[{job_id:'job1'}];}};
  const result=await applyProviderConfirmation(sql,{provider:'meta_whatsapp',destination:'channel:whatsapp',provider_message_id:'wamid.1',status:'read',rank:30,occurred_at_ms:1788260000000,provider_event_id:'meta:1'});
  assert.equal(result.updated,true);assert.match(calls[0].q,/provider_acceptance/);assert.match(calls[0].q,/occurred_at_ms/);assert.match(calls[0].q,/rank/);assert.equal(calls[0].a[1],'wamid.1');
  assert.equal(calls.length,2);assert.match(calls[1].q,/live_action_plan/);assert.equal(calls[1].a[0],'run1');assert.match(calls[1].a[1],/provider_confirmation/);
});

test('Resend received event is not misclassified as outbound delivery',()=>{
  assert.equal(normalizeResendDeliveryEvent({type:'email.received',data:{email_id:'incoming_1'}}),null);
});
