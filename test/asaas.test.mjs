import test from 'node:test';
import assert from 'node:assert/strict';
import {
  secureTokenEqual,
  normalizeAsaasWebhook,
  parseExternalReference,
  normalizeFinancialEvent,
  paymentMatchesWebhook,
  paymentMatchesOrderWebhook,
  supersededPartialRefund,
  completedRefundTotal,
  refundTotalForWebhook,
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
  const payment={id:'pay_abcdef12',externalReference:`ZEVANORY:EXP-0001:${orderId}`,value:1197,status:'CONFIRMED'};
  assert.equal(parseExternalReference(payment.externalReference),orderId);
  assert.equal(paymentMatchesWebhook(webhook,payment),true);
  assert.equal(paymentMatchesWebhook(webhook,{...payment,value:1196}),false);
  assert.equal(paymentMatchesWebhook(webhook,{...payment,status:'PENDING'}),false);
});

test('hosted Checkout payment reconciles through its exact checkout session',()=>{
  const checkoutId='92af3092-92a6-43a6-b24d-ebeaee8b2390';
  const webhook=normalizeAsaasWebhook({event:'PAYMENT_CONFIRMED',id:'evt_checkout1',payment:{id:'pay_checkout1'}});
  const order={order_id:orderId,external_reference:`ZEVANORY:EXP-0001:${orderId}`,provider_checkout_id:checkoutId,amount:1197};
  const payment={id:'pay_checkout1',externalReference:null,checkoutSession:checkoutId,value:1197,status:'CONFIRMED'};
  assert.equal(paymentMatchesOrderWebhook(webhook,payment,order),true);
  assert.equal(paymentMatchesOrderWebhook(webhook,{...payment,checkoutSession:'6ba7b810-9dad-11d1-80b4-00c04fd430c8'},order),false);
  assert.equal(paymentMatchesOrderWebhook(webhook,{...payment,externalReference:`ZEVANORY:EXP-0001:6ba7b810-9dad-11d1-80b4-00c04fd430c8`},order),false);
  assert.equal(paymentMatchesOrderWebhook(webhook,{...payment,value:1196},order),false);
});

test('stale partial refund is acknowledged only after provider reached exact full refund',()=>{
  const checkoutId='92af3092-92a6-43a6-b24d-ebeaee8b2390';
  const webhook=normalizeAsaasWebhook({event:'PAYMENT_PARTIALLY_REFUNDED',id:'evt_stale001',payment:{id:'pay_stale001'}});
  const order={order_id:orderId,external_reference:`ZEVANORY:EXP-0001:${orderId}`,provider_checkout_id:checkoutId,amount:1197};
  const payment={id:'pay_stale001',externalReference:null,checkoutSession:checkoutId,value:1197,status:'REFUNDED',refunds:[{status:'DONE',value:100},{status:'DONE',value:1097}]};
  assert.equal(supersededPartialRefund(webhook,payment,order),true);
  assert.equal(supersededPartialRefund(webhook,{...payment,status:'RECEIVED'},order),false);
  assert.equal(supersededPartialRefund(webhook,{...payment,refunds:[{status:'DONE',value:100}]},order),false);
});

test('partial refund uses only DONE items and stays below gross amount',()=>{
  const webhook=normalizeAsaasWebhook({event:'PAYMENT_PARTIALLY_REFUNDED',id:'evt_partial01',payment:{id:'pay_partial01'}});
  const payment={id:'pay_partial01',externalReference:`ZEVANORY:EXP-0001:${orderId}`,value:1197,status:'RECEIVED',refunds:[
    {status:'DONE',value:100},{status:'PENDING',value:50},{status:'CANCELLED',value:25}
  ]};
  assert.equal(completedRefundTotal(payment),100);
  assert.equal(refundTotalForWebhook(webhook,payment),100);
  assert.equal(paymentMatchesWebhook(webhook,payment),true);
});

test('full refund requires exact DONE total and REFUNDED payment status',()=>{
  const webhook=normalizeAsaasWebhook({event:'PAYMENT_REFUNDED',id:'evt_refund01',payment:{id:'pay_refund01'}});
  const payment={id:'pay_refund01',externalReference:`ZEVANORY:EXP-0001:${orderId}`,value:1197,status:'REFUNDED',refunds:[
    {status:'DONE',value:200},{status:'DONE',value:997}
  ]};
  assert.equal(refundTotalForWebhook(webhook,payment),1197);
  assert.equal(paymentMatchesWebhook(webhook,payment),true);
  assert.equal(paymentMatchesWebhook(webhook,{...payment,status:'RECEIVED'}),false);
});

test('refund reconciliation rejects zero over-refund and mismatched event type',()=>{
  const partial=normalizeAsaasWebhook({event:'PAYMENT_PARTIALLY_REFUNDED',id:'evt_partial02',payment:{id:'pay_partial02'}});
  const base={id:'pay_partial02',externalReference:`ZEVANORY:EXP-0001:${orderId}`,value:1197,status:'RECEIVED'};
  assert.equal(refundTotalForWebhook(partial,{...base,refunds:[]}),null);
  assert.equal(refundTotalForWebhook(partial,{...base,refunds:[{status:'DONE',value:1198}]}),null);
  assert.equal(refundTotalForWebhook(partial,{...base,refunds:[{status:'DONE',value:1197}]}),null);
});

