import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEmailReadiness } from '../src/emailReadiness.mjs';

test('email readiness requires exact DNS and both Resend secrets',()=>{
  const base={
    mx:[{exchange:'inbound-smtp.sa-east-1.amazonaws.com',priority:10}],
    dkim:[['p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQxyz']],
    dmarc:[['v=DMARC1; p=none;']],
    env:{RESEND_FORWARD_TO:'zevanory@gmail.com',RESEND_FROM_ADDRESS:'ZEVANORY <contato@zevanory.api.br>'}
  };
  const blocked=evaluateEmailReadiness(base);
  assert.equal(blocked.dns_ready,true); assert.equal(blocked.secrets_ready,false); assert.equal(blocked.activation_ready,false);
  const ready=evaluateEmailReadiness({...base,env:{...base.env,RESEND_API_KEY:'re_x',RESEND_WEBHOOK_SECRET:'whsec_x'}});
  assert.equal(ready.activation_ready,true); assert.equal(ready.config.inbound_enabled,false);
});

test('email readiness rejects wrong MX or DMARC',()=>{
  const r=evaluateEmailReadiness({mx:[{exchange:'example.com',priority:10}],dkim:[['p=x']],dmarc:[['v=DMARC1; p=reject;']],env:{}});
  assert.equal(r.dns_ready,false); assert.equal(r.activation_ready,false);
});
