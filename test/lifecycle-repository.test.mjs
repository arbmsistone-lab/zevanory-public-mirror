import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ensureCustomerProfile,recordCustomerLifecycleEvent,recordAttributionTouchpoint,loadAttributionTouchpoints } from '../src/lifecycleRepository.mjs';

const customer='550e8400-e29b-41d4-a716-446655440000';
const lead='550e8400-e29b-41d4-a716-446655440001';
const order='550e8400-e29b-41d4-a716-446655440002';

test('migration 012 persists customer lifecycle and attribution without new PII columns',()=>{
  const sql=fs.readFileSync('db/migrations/012_sales_lifecycle_v2.sql','utf8');
  assert.match(sql,/customer_lifecycle_profiles/);
  assert.match(sql,/customer_lifecycle_events/);
  assert.match(sql,/attribution_touchpoints/);
  assert.match(sql,/012_sales_lifecycle_v2/);
  assert.doesNotMatch(sql,/\b(email|phone|name|address)\b/i);
});

test('customer profile persistence validates identifiers and bounds scores',async()=>{
  const calls=[];const db={query:async(q,args)=>{calls.push({q,args});return [{customer_id:customer,stage:'onboarding'}];}};
  const row=await ensureCustomerProfile(db,{customer_id:customer,lead_id:lead,adoption_score:2,support_risk:-1});
  assert.equal(row.customer_id,customer);
  assert.equal(calls[0].args[4],1);assert.equal(calls[0].args[6],0);
  await assert.rejects(()=>ensureCustomerProfile(db,{customer_id:'bad'}),/customer_id_invalid/);
});
test('lifecycle events are idempotent and update profile only after insert',async()=>{
  const calls=[];const db={query:async(q,args)=>{calls.push({q,args});return [{customer_id:customer,stage:'retention',purchase_count:1}];}};
  const result=await recordCustomerLifecycleEvent(db,{customer_id:customer,order_id:order,event_type:'retention_intervention',source:'agent',idempotency_key:'retention:0001'});
  assert.equal(result.inserted,true);
  assert.match(calls[0].q,/on conflict\(idempotency_key\) do nothing/i);
  assert.match(calls[0].q,/exists\(select 1 from ins\)/i);
  await assert.rejects(()=>recordCustomerLifecycleEvent(db,{customer_id:customer,event_type:'unknown',idempotency_key:'unknown:0001'}),/lifecycle_event_invalid/);
});

test('attribution touchpoints are idempotent and load in deterministic order',async()=>{
  const calls=[];const db={query:async(q,args)=>{calls.push({q,args});return q.includes('select touchpoint_id')?[{id:'t1',channel:'instagram'}]:[{touchpoint_id:'t1',channel:'instagram'}];}};
  const saved=await recordAttributionTouchpoint(db,{session_id:customer,lead_id:lead,order_id:order,channel:'Instagram',idempotency_key:'touch:0001'});
  assert.equal(saved.inserted,true);assert.equal(calls[0].args[4],'instagram');
  const rows=await loadAttributionTouchpoints(db,{order_id:order});
  assert.equal(rows[0].channel,'instagram');assert.match(calls[1].q,/order by occurred_at asc,touchpoint_id asc/i);
});
