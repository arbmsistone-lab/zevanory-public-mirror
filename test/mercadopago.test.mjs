import test from 'node:test';
import { PROJECT } from '../src/config.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildMercadoPagoPreference,normalizeMercadoPagoPreference,normalizeMercadoPagoWebhook,verifyMercadoPagoSignature,normalizeMercadoPagoFinancialEvent } from '../src/mercadopago.mjs';
import { createMercadoPagoPreference } from '../src/http/checkoutMercadoPago.mjs';
import { fetchMercadoPagoPayment } from '../src/http/webhookMercadoPago.mjs';

const orderId='550e8400-e29b-41d4-a716-446655440000';
const ref=`ZEVANORY:EXP-0001:${orderId}`;

test('Mercado Pago preference is first-party tracked and hosted',()=>{
  const p=buildMercadoPagoPreference(orderId,'https://zevanory.api.br');
  assert.equal(p.external_reference,ref); assert.equal(p.items[0].currency_id,'BRL'); assert.equal(p.items[0].unit_price,PROJECT.experimentalPriceBrl);
  assert.equal(p.notification_url,'https://zevanory.api.br/api/webhooks/mercadopago');
});

test('Mercado Pago certification preference isolates sandbox webhook',()=>{
  const p=buildMercadoPagoPreference(orderId,'https://zevanory.api.br',undefined,{notificationPath:'/api/webhooks?provider=mercadopago_test'});
  assert.equal(p.notification_url,'https://zevanory.api.br/api/webhooks?provider=mercadopago_test');
  assert.equal(p.items[0].unit_price,PROJECT.experimentalPriceBrl);
});

test('Mercado Pago checkout creation uses bearer token',async()=>{
  let seen; const result=await createMercadoPagoPreference({external_reference:ref},'token',async(url,opts)=>{seen={url,opts};return {ok:true,json:async()=>({id:'pref-1'})};});
  assert.match(seen.url,/api\.mercadopago\.com\/checkout\/preferences$/); assert.equal(seen.opts.headers.authorization,'Bearer token'); assert.equal(result.id,'pref-1');
});

test('Mercado Pago preference response rejects untrusted checkout domains',()=>{
  assert.equal(normalizeMercadoPagoPreference({id:'pref-1234',external_reference:ref,init_point:'https://evil.example/pay'},ref,'production'),null);
  const ok=normalizeMercadoPagoPreference({id:'pref-1234',external_reference:ref,init_point:'https://www.mercadopago.com.br/checkout/v1/redirect'},ref,'production'); assert.equal(ok.id,'pref-1234');
});

test('Mercado Pago webhook signature is HMAC and time bounded',()=>{
  const dataId='1234567890',requestId='req-123',secret='secret',ts=String(Math.floor(Date.now()/1000));
  const manifest=`id:${dataId};request-id:${requestId};ts:${ts};`; const v1=crypto.createHmac('sha256',secret).update(manifest).digest('hex');
  assert.equal(verifyMercadoPagoSignature({signature:`ts=${ts},v1=${v1}`,requestId,dataId,secret}),true);
  assert.equal(verifyMercadoPagoSignature({signature:`ts=${ts},v1=${'0'.repeat(64)}`,requestId,dataId,secret}),false);
});

test('Mercado Pago webhook and server lookup require payment id',async()=>{
  assert.deepEqual(normalizeMercadoPagoWebhook({type:'payment',data:{id:'1234567890'}},'/?data.id=1234567890'),{paymentId:'1234567890'});
  let seen; const p=await fetchMercadoPagoPayment('1234567890','token',async(url,opts)=>{seen={url,opts};return {ok:true,json:async()=>({id:1234567890})};});
  assert.equal(p.id,1234567890); assert.match(seen.url,/\/v1\/payments\/1234567890$/); assert.equal(seen.opts.headers.authorization,'Bearer token');
});

test('Mercado Pago financial truth requires exact reference amount and final status',()=>{
  const order={external_reference:ref,amount:PROJECT.experimentalPriceBrl};
  assert.equal(normalizeMercadoPagoFinancialEvent({external_reference:ref,transaction_amount:PROJECT.experimentalPriceBrl,status:'approved'},order).normalized,'payment_confirmed');
  assert.equal(normalizeMercadoPagoFinancialEvent({external_reference:ref,transaction_amount:498,status:'approved'},order),null);
  assert.equal(normalizeMercadoPagoFinancialEvent({external_reference:ref,transaction_amount:PROJECT.experimentalPriceBrl,status:'pending'},order),null);
});
