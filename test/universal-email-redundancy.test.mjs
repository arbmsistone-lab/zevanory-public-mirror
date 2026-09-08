import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { publishViaBuffer } from '../src/bufferSocial.mjs';

const gate=()=>({enabled:true});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('email reroutes from unconfigured Resend to independent Brevo provider',async()=>{
  const calls=[];
  const env={BREVO_API_KEY:'brevo-key',BREVO_FROM_ADDRESS:'sender@example.test'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response({messageId:'brevo-1'},201);}});
  const result=await adapters['channel:email']({event_id:'evt-email-1',payload:{contact_ref:'to@example.test',text:'hello',subject:'Test'}});
  assert.equal(result.provider,'brevo');
  assert.equal(result.execution_provider,'brevo-email');
  assert.equal(calls[0].url,'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].opt.headers['api-key'],'brevo-key');
});

test('Buffer network uncertainty is reconciliation-required, never blind failover',async()=>{
  const env={BUFFER_API_KEY:'buf',BUFFER_LINKEDIN_CHANNEL_ID:'li-1'};
  await assert.rejects(()=>publishViaBuffer({channel:'linkedin',event:{payload:{content:'x'}},env,fetchImpl:async()=>{throw new Error('network');}}),error=>{
    assert.equal(error.ambiguous,true);return true;
  });
});

test('email can route through independent Mailjet provider',async()=>{
  const calls=[];
  const env={MJ_APIKEY_PUBLIC:'public',MJ_APIKEY_PRIVATE:'private',MAILJET_FROM_ADDRESS:'sender@example.test'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response({Messages:[{Status:'success',To:[{MessageID:12345}]}]},200);}});
  const result=await adapters['channel:email']({event_id:'evt-email-2',payload:{contact_ref:'to@example.test',text:'hello'}});
  assert.equal(result.provider,'mailjet');
  assert.equal(result.execution_provider,'mailjet-email');
  assert.equal(calls[0].url,'https://api.mailjet.com/v3.1/send');
  assert.match(calls[0].opt.headers.authorization,/^Basic /);
});
