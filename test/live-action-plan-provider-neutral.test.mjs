import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLiveActionPlan } from '../src/liveActionPlan.mjs';

const job={job_id:'11111111-1111-4111-8111-111111111111',job_type:'checkout',payload:{}};
const auth={allowed:true,risk_level:'financial',reason:'test'};

test('financial plan uses capability when scheduler has not selected a provider',()=>{
  const plan=buildLiveActionPlan({job,tool:'start_checkout',auth,decision:{action:'start_checkout'},context:{},env:{PAYMENT_PROVIDER:'legacy-should-not-control'}});
  assert.equal(plan.where,'capability:payment');
  assert.equal(plan.account_ref,'merchant:unresolved');
});

test('financial plan records provider chosen by decision without reading legacy env',()=>{
  const plan=buildLiveActionPlan({job,tool:'start_checkout',auth,decision:{action:'start_checkout',provider:'mercadopago'},context:{},env:{PAYMENT_PROVIDER:'asaas'}});
  assert.equal(plan.where,'payment:mercadopago');assert.equal(plan.account_ref,'merchant:mercadopago');
});

test('live action plan source does not use legacy PAYMENT_PROVIDER',async()=>{
  const source=await readFile(new URL('../src/liveActionPlan.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/env\.?PAYMENT_PROVIDER|env\?\.PAYMENT_PROVIDER/);
});
