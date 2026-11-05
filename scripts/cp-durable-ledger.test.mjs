// NC-007 ADR-CP-001: 9 reproducible tests on Node native SQLite (Node >=22).
// SQLite transactions are real; Cloudflare cross-region delivery remains a separate real gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CpSubscriberLedger, CpTransitionError, ContentProntoSubscriberDO } from '../worker/cp-durable-ledger.mjs';

function harness(){
 const db=new DatabaseSync(':memory:');
 const sql={exec(q,...args){
  const s=q.trim();
  if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
  if(/^CREATE\s+TABLE/i.test(s)){db.exec(s);return {toArray:()=>[]};}
  db.prepare(s).run(...args);return {toArray:()=>[]};
 }};
 const storage={sql,transactionSync(fn){
  db.exec('BEGIN IMMEDIATE');
  try{const result=fn();db.exec('COMMIT');return result;}
  catch(e){db.exec('ROLLBACK');throw e;}
 }};
 const ledger=new CpSubscriberLedger(storage,'cp-do:test-subscription-abcdef');
 return {ledger,storage,db};
}
const intent=(event_key,kind,cycle,extra={})=>({event_key,kind,cycle,...extra});
function rejected(fn,reason,status){
 assert.throws(fn,e=>e instanceof CpTransitionError && e.code===reason && (status===undefined || e.status===status),reason);
}
test('R11-1 two webhooks same event_key => one ledger transition',()=>{
 const {ledger}=harness();
 const e=intent('webhook:transaction-0001','approved',1);
 assert.equal(ledger.apply(e).code,'applied');
 assert.equal(ledger.apply(e).code,'duplicate_event');
 assert.equal(ledger.snapshot().event_count,1);
 assert.equal(ledger.snapshot().version,1);
});
test('R11-2 webhook x cron same monthly delivery => one outbox',()=>{
 const {ledger}=harness();ledger.apply(intent('webhook:approved-0002','approved',1));
 ledger.apply(intent('cron:day-000000001','queue_delivery',1));
 ledger.apply(intent('webhook:queue-0002','queue_delivery',1));
 const s=ledger.snapshot();
 assert.equal(s.outbox.length,1);
 assert.equal(s.outbox[0].status,'pending');
 assert.equal(s.outbox[0].provider_idempotency_key,'cp-do:test-subscription-abcdef/delivery/1');
});
test('R11-3 operator and webhook stale expected_version => 409, monotonic',()=>{
 const {ledger}=harness();ledger.apply(intent('webhook:approved-0003','approved',1));
 const version=ledger.snapshot().version;
 ledger.apply(intent('operator:stop-000003','operator_stop',1,{expected_version:version}));
 rejected(()=>ledger.apply(intent('webhook:renews-0003','approved',2,{expected_version:version})),'stale_version',409);
 const s=ledger.snapshot();assert.equal(s.version,version+1);assert.equal(s.cycle,1);assert.equal(s.status,'inactive');
});
test('R11-4 refund after delivered: delivery receipt never regresses',()=>{
 const {ledger}=harness();ledger.apply(intent('webhook:approved-0004','approved',1));
 ledger.apply(intent('cron:deliver-000004','queue_delivery',1));
 ledger.apply(intent('provider:receipt-004','provider_receipt',1,{receipt:'receipt-provider-000004'}));
 ledger.apply(intent('webhook:refunded-004','refund',1));
 const s=ledger.snapshot();
 assert.equal(s.delivered_cycle,1);assert.equal(s.outbox[0].status,'sent');
 assert.equal(s.outbox[0].receipt,'receipt-provider-000004');assert.equal(s.refunds.length,1);
 rejected(()=>ledger.apply(intent('webhook:reapprove-004','approved',1)),'terminal_refund');
});
test('R11-5 crash after local COMMIT before send: pending outbox recovers with idempotency',()=>{
 const {ledger,storage}=harness();ledger.apply(intent('webhook:approved-0005','approved',1));
 ledger.apply(intent('cron:delivery-00005','queue_delivery',1));
 const pending=ledger.snapshot().outbox[0];assert.equal(pending.status,'pending');
 const reopened=new CpSubscriberLedger(storage,'cp-do:test-subscription-abcdef');
 assert.deepEqual(reopened.snapshot().outbox[0],pending);
 reopened.apply(intent('provider:uncertain05','provider_uncertain',1));
 assert.equal(reopened.snapshot().outbox[0].status,'uncertain','ambiguous outcome must wait for reconciliation, never auto resend');
 reopened.apply(intent('provider:receipt-005','provider_receipt',1,{receipt:'receipt-provider-000005'}));
 assert.equal(reopened.snapshot().outbox[0].status,'sent');
});
test('R11-6 two simulated Worker regions share one DO SQL: deterministic single outbox',async()=>{
 const {ledger,storage}=harness();ledger.apply(intent('webhook:approved-0006','approved',1));
 const other=new CpSubscriberLedger(storage,'cp-do:test-subscription-abcdef');
 const one=Promise.resolve().then(()=>ledger.apply(intent('region-a-delivery-00006','queue_delivery',1)));
 const two=Promise.resolve().then(()=>other.apply(intent('region-b-delivery-00006','queue_delivery',1)));
 await Promise.all([one,two]);assert.equal(ledger.snapshot().outbox.length,1);
 assert.equal(ledger.snapshot().event_count,3);
});
test('R11-7 internal DO rejects subscriber_id from client payload',async()=>{
 const {storage}=harness();
 const doObj=new ContentProntoSubscriberDO({storage,id:{toString:()=> 'test-subscription-abcdef'}});
 const r=await doObj.fetch(new Request('https://internal.example/internal/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(intent('webhook:approved-0007','approved',1,{subscriber_id:'OTHER_ACCOUNT'}))}));
 assert.equal(r.status,403);
 assert.equal((await r.json()).error,'client_subscriber_forbidden');
 assert.equal((await doObj.fetch(new Request('https://internal.example/internal/snapshot'))).status,200);
});
test('R11-8 SQLite quota unavailable => 503 no KV fallback',()=>{
 const {storage,ledger}=harness();const orig=storage.sql.exec;
 storage.sql.exec=(q,...args)=>{if(/INSERT INTO cp_event_ledger/.test(q))throw Error('SQLITE_FULL');return orig(q,...args)};
 rejected(()=>ledger.apply(intent('webhook:approved-0008','approved',1)),'sqlite_unavailable',503);
 assert.equal(ledger.snapshot().event_count,0);assert.equal(ledger.snapshot().version,0);
});
test('R11-9 synthetic migration/restart and append-only audit export',()=>{
 const {storage,ledger}=harness();ledger.apply(intent('migration:approved-0009','approved',1));
 ledger.apply(intent('migration:queue-0009','queue_delivery',1));
 const copy=new CpSubscriberLedger(storage,'cp-do:test-subscription-abcdef');
 assert.equal(copy.snapshot().event_count,2);assert.equal(copy.exportEvents(0).length,2);
 assert.equal(copy.exportEvents(1).length,1);
 assert.equal(copy.snapshot().outbox.length,1);
 // This test never writes to Cloudflare KV or reads actual subscribers.
});
