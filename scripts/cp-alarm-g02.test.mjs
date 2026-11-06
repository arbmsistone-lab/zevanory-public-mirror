import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {CpSubscriberLedger,ContentProntoSubscriberDO,CpTransitionError} from '../worker/cp-durable-ledger.mjs';
function make(){
 const db=new DatabaseSync(':memory:');
 const sql={exec(q,...args){const s=q.trim();if(/^SELECT\b/i.test(s))return{toArray:()=>db.prepare(s).all(...args)};
 if(/^CREATE\s+(?:TABLE|INDEX)/i.test(s)){db.exec(s);return{toArray:()=>[]}};
 db.prepare(s).run(...args);return{toArray:()=>[]};}};
 const storage={sql,alarms:[],transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e}},
 async setAlarm(ms){this.alarms.push(ms)},async getAlarm(){return this.alarms.at(-1)||null}};
 return {db,storage,ledger:new CpSubscriberLedger(storage,'cp-do:subscriber-test-abcdef')};
}
test('G02 six normalized tables plus due index and timestamp CHECK',()=>{
 const {db}=make();
 const rows=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
 for(const x of ['cp_cycles','cp_credits','cp_refund_events','cp_regen_jobs','cp_delivery_receipts','cp_alarm_jobs','cp_alarm_outbox'])assert.ok(rows.includes(x),x);
 assert.throws(()=>db.prepare("INSERT INTO cp_cycles(cycle,approved_at_ms,release_at_ms,status,created_at,updated_at) VALUES(1,1000,999,'approved','now','now')").run(),/CHECK/);
});
test('M1 earliest of multiple subscriber alarms always wins',()=>{
 const {ledger}=make();
 const a=ledger.scheduleAlarmJob({alarm_key:'cp:retry:000001',kind:'retry',due_at_ms:5000});
 const b=ledger.scheduleAlarmJob({alarm_key:'cp:release:0001',kind:'release_192h',due_at_ms:10000});
 assert.equal(a.next,5000);assert.equal(b.next,5000);
 assert.equal(ledger.nextAlarmAt(),5000);
 assert.equal(ledger.scheduleAlarmJob({alarm_key:'cp:retry:000001',kind:'retry',due_at_ms:5000}).code,'duplicate_alarm');
 assert.throws(()=>ledger.scheduleAlarmJob({alarm_key:'cp:retry:000001',kind:'retry',due_at_ms:3000}),/alarm_conflict/);
});
test('M1 exact time boundary and idempotency of alarm queue',()=>{
 const {ledger,db}=make();
 ledger.scheduleAlarmJob({alarm_key:'cp:release:0002',kind:'release_192h',due_at_ms:7000});
 assert.equal(ledger.claimDueAlarmJobs(6999).queued,0);
 assert.equal(ledger.claimDueAlarmJobs(7000).queued,1);
 assert.equal(ledger.claimDueAlarmJobs(7500).queued,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cp_alarm_outbox").get().n,1);
 assert.equal(db.prepare("SELECT status FROM cp_alarm_outbox").get().status,'pending');
});
test('M1 restart recovers durable scheduled alarm/outbox without resending',()=>{
 const {storage,ledger}=make();ledger.scheduleAlarmJob({alarm_key:'cp:reminder:0003',kind:'reminder',due_at_ms:2500});
 const restarted=new CpSubscriberLedger(storage,'cp-do:subscriber-test-abcdef');
 assert.equal(restarted.nextAlarmAt(),2500);
 assert.equal(restarted.claimDueAlarmJobs(2500).queued,1);
 assert.equal(new CpSubscriberLedger(storage,'cp-do:subscriber-test-abcdef').claimDueAlarmJobs(4000).queued,0);
});
test('DO schedule endpoint sets only earliest one and alarm enqueues without network',async()=>{
 const {storage,db}=make();
 const ctx={storage,id:{toString:()=> 'subscriber-test-abcdef'}};
 const obj=new ContentProntoSubscriberDO(ctx);
 const post=async(alarm_key,due_at_ms)=>obj.fetch(new Request('https://internal.example/internal/schedule',
  {method:'POST',body:JSON.stringify({alarm_key,kind:'release_192h',due_at_ms}),headers:{'content-type':'application/json'}}));
 assert.equal((await post('release:job:00004',Date.now()+10000)).status,200);
 assert.equal(storage.alarms.length,1);
 assert.equal((await post('release:job:00005',Date.now()+5000)).status,200);
 assert.equal(storage.alarms.length,2);
 // Force both jobs due in SQLite; alarm method only queues, no outbound sends.
 db.prepare("UPDATE cp_alarm_jobs SET due_at_ms=1 WHERE state='scheduled'").run();
 await obj.alarm();
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cp_alarm_outbox").get().n,2);
 assert.equal(storage.alarms.length,2,'nothing else scheduled with no future event');
});
