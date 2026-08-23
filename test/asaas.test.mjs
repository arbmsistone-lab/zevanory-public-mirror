import test from 'node:test';
import assert from 'node:assert/strict';
import {
  secureTokenEqual,
  normalizeAsaasWebhook,
  parseExternalReference,
  normalizeFinancialEvent,
  paymentMatchesWebhook,
} from '../src/asaas.mjs';

const orderId='550e8400-e29b-41d4-a716-446655440000';

test('Asaas webhook token comparison is fail-closed',()=>{
  assert.equal(secureTokenEqual('secret-123','secret-123'),true);
  assert.equal(secureTokenEqual('secret-123','secret-124'),false);
  assert.equal(secureTokenEqual('',''),false);
});

test('Asaas webhook normalization accepts only financial events',()=>{
  const valid=normalizeAsaasWebhook({event:'PAYMENT_RECEIVED',id:'evt_123456789',payment:{id:'pay_123456789'}});
  assert.equal(valid?.eventName,'PAYMENT_RECEIVED');
  assert.equal(normalizeFinancialEvent(valid.eventName),'payment_confirmed');
  assert.equal(normalizeAsaasWebhook({event:'PAYMENT_CREATED',id:'evt_123456789',payment:{id:'pay_123456789'}}),null);
});

test('Asaas payment reconciliation requires exact provider truth',()=>{
  const webhook=normalizeAsaasWebhook({event:'PAYMENT_CONFIRMED',id:'evt_abcdef12',payment:{id:'pay_abcdef12'}});
  const payment={id:'pay_abcdef12',externalReference:`ZEVANORY:EXP-0001:${orderId}`,value:497,status:'CONFIRMED'};
  assert.equal(parseExternalReference(payment.externalReference),orderId);
  assert.equal(paymentMatchesWebhook(webhook,payment),true);
  assert.equal(paymentMatchesWebhook(webhook,{...payment,value:496}),false);
  assert.equal(paymentMatchesWebhook(webhook,{...payment,status:'PENDING'}),false);
});
