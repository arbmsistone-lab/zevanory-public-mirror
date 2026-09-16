import test from 'node:test';
import assert from 'node:assert/strict';
import { ARBM_CONTADOR_SUBSCRIPTION_PLANS, buildMercadoPagoSubscriptionPlanPayload, validateMercadoPagoSubscriptionPlanResponse } from '../src/arbmContadorSubscription.mjs';
import subscriptionHandler from '../src/http/arbmContadorSubscription.mjs';

const fakeResponse=()=>({statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;return body;}});

test('ARBM Contador monthly and annual plans are exact and provider-compatible',()=>{
  assert.equal(ARBM_CONTADOR_SUBSCRIPTION_PLANS.monthly.amount_brl,59.90);
  assert.equal(ARBM_CONTADOR_SUBSCRIPTION_PLANS.annual.amount_brl,599.00);
  const monthly=buildMercadoPagoSubscriptionPlanPayload('monthly');
  const annual=buildMercadoPagoSubscriptionPlanPayload('annual');
  assert.equal(monthly.auto_recurring.frequency,1); assert.equal(monthly.auto_recurring.frequency_type,'months');
  assert.equal(annual.auto_recurring.frequency,12); assert.equal(annual.auto_recurring.currency_id,'BRL');
  assert.match(monthly.reason,/ARBM Contador para Salões/);
});

test('Mercado Pago plan response must match exact certified economics',()=>{
  const valid={id:'plan_12345678',status:'active',init_point:'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=plan_12345678',auto_recurring:{frequency:1,frequency_type:'months',transaction_amount:59.90,currency_id:'BRL'}};
  assert.equal(validateMercadoPagoSubscriptionPlanResponse(valid,'monthly')?.amount_brl,59.90);
  assert.equal(validateMercadoPagoSubscriptionPlanResponse({...valid,auto_recurring:{...valid.auto_recurring,transaction_amount:60}},'monthly'),null);
  assert.equal(validateMercadoPagoSubscriptionPlanResponse({...valid,init_point:'https://evil.example/checkout'},'monthly'),null);
});

test('subscription checkout is globally fail-closed before provider access',async()=>{
  const previous={SALE_GLOBALLY_ENABLED:process.env.SALE_GLOBALLY_ENABLED,PRE_SALE_GATES_APPROVED:process.env.PRE_SALE_GATES_APPROVED,ABSOLUTE_RELEASE_APPROVED:process.env.ABSOLUTE_RELEASE_APPROVED};
  process.env.SALE_GLOBALLY_ENABLED='false'; process.env.PRE_SALE_GATES_APPROVED='false'; process.env.ABSOLUTE_RELEASE_APPROVED='false';
  const req={method:'POST',headers:{},body:{plan_id:'monthly'}}; const res=fakeResponse();
  await subscriptionHandler(req,res);
  assert.equal(res.statusCode,503); assert.equal(JSON.parse(res.body).error,'sales_globally_blocked');
  for(const [k,v] of Object.entries(previous)){if(v===undefined) delete process.env[k]; else process.env[k]=v;}
});

test('Cloudflare runtime exposes dedicated subscription route separately from one-time checkout',async()=>{
  const {readFile}=await import('node:fs/promises'); const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
  assert.match(worker,/\/api\/subscriptions\/arbm-contador/);
  assert.match(worker,/arbmContadorSubscriptionHandler/);
});
