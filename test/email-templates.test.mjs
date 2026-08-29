import test from 'node:test';
import assert from 'node:assert/strict';
import {EMAIL_IDENTITIES,launchWelcome,checkoutStarted,paymentConfirmed,supportAcknowledgement} from '../src/emailTemplates.mjs';

test('professional identities use zevanory domain',()=>{
  for(const value of Object.values(EMAIL_IDENTITIES)) assert.match(value,/@zevanory\.api\.br/);
});

test('launch and checkout templates avoid invented outcomes',()=>{
  assert.match(launchWelcome('Cliente').text,/nao promete resultados inventados/i);
  assert.match(checkoutStarted().text,/confirmacao real do pagamento/i);
});

test('paid delivery requires https secure URL',()=>{
  assert.throws(()=>paymentConfirmed('http://example.test/file'),/secure_delivery_url_required/);
  assert.match(paymentConfirmed('https://secure.example.test/token').text,/https:\/\/secure\.example\.test\/token/);
});

test('support acknowledgement requires ticket id',()=>{
  assert.throws(()=>supportAcknowledgement(''),/ticket_id_required/);
  assert.match(supportAcknowledgement('ZEV-123').subject,/ZEV-123/);
});