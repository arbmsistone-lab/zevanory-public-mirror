import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEmailReadiness } from '../src/emailReadiness.mjs';
const base = () => ({
  mx: [{exchange:'inbound-smtp.us-east-1.amazonaws.com',priority:10}],
  dkim: [['p=current','providerkey']], dmarc: [['v=DMARC1; p=reject;']],
  env: {RESEND_FORWARD_TO:'zevanory@gmail.com', RESEND_FROM_ADDRESS:'ZEVANORY <contato@zevanory.api.br>', RESEND_API_KEY:'test-only', RESEND_WEBHOOK_SECRET:'test-only', EMAIL_INBOUND_ENABLED:'true'},
  providerDomain: {name:'zevanory.api.br',status:'verified',capabilities:{receiving:'enabled'},records:[
    {type:'MX',name:'@',value:'inbound-smtp.us-east-1.amazonaws.com',priority:10,status:'verified'},
    {type:'TXT',record:'DKIM',name:'resend._domainkey',value:'p=currentproviderkey',status:'verified'}
  ]}, webhookVerified:true,
});
test('fresh provider DNS and explicit inbound configuration allow preflight only',()=>{const r=evaluateEmailReadiness(base());assert.equal(r.activation_ready,true);assert.equal(r.delivery_proven,false);});
test('disabled, missing and nonliteral inbound activation fail closed',()=>{for(const value of [undefined,'false','TRUE','1',true]){const b=base();b.env.EMAIL_INBOUND_ENABLED=value;const r=evaluateEmailReadiness(b);assert.equal(r.config_ready,false);assert.equal(r.activation_ready,false);}});
test('secret presence alone cannot establish provider readiness',()=>{const b=base();delete b.providerDomain;assert.equal(evaluateEmailReadiness(b).activation_ready,false);});
test('rotated DKIM, wrong MX and competing preferred MX fail closed',()=>{for(const change of [b=>b.dkim=[['p=oldkey']],b=>b.mx[0].exchange='wrong.example',b=>b.mx.push({exchange:'other.example',priority:1})]){const b=base();change(b);assert.equal(evaluateEmailReadiness(b).activation_ready,false);}});
test('provider disabled, wrong domain, unverified records or webhook block activation',()=>{for(const change of [b=>b.providerDomain.capabilities.receiving='disabled',b=>b.providerDomain.name='other.example',b=>b.providerDomain.records[0].status='pending',b=>b.webhookVerified=false]){const b=base();change(b);assert.equal(evaluateEmailReadiness(b).activation_ready,false);}});
test('DMARC accepts defined policies and rejects duplicate records',()=>{for(const p of ['none','quarantine','reject']){const b=base();b.dmarc=[['v=DMARC1; p='+p+';']];assert.equal(evaluateEmailReadiness(b).dns.dmarc,true);}const b=base();b.dmarc.push(['v=DMARC1; p=none;']);assert.equal(evaluateEmailReadiness(b).activation_ready,false);});
test('missing secrets and misleading sender addresses block activation',()=>{for(const change of [b=>delete b.env.RESEND_API_KEY,b=>delete b.env.RESEND_WEBHOOK_SECRET,b=>b.env.RESEND_FROM_ADDRESS='contato@zevanory.api.br.evil.example']){const b=base();change(b);assert.equal(evaluateEmailReadiness(b).activation_ready,false);}});
