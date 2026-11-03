import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {ContentProntoSubscriberDO} from "../worker/cp-durable-ledger.mjs";
function harness(){
 const db=new DatabaseSync(":memory:");
 const sql={exec(q,...args){const s=q.trim();
  if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
  if(/^CREATE\s+(TABLE|INDEX)/i.test(s)){db.exec(s);return {toArray:()=>[]}};
  db.prepare(s).run(...args);return {toArray:()=>[]};
 }};
 let alarms=[];
 const storage={sql,setAlarm:async due=>alarms.push(due),transactionSync(fn){db.exec("BEGIN IMMEDIATE");try{const x=fn();db.exec("COMMIT");return x}catch(e){db.exec("ROLLBACK");throw e}}};
 const o=new ContentProntoSubscriberDO({storage,id:{toString:()=>("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")}}),now=Date.now();
 const call=async obj=>o.fetch(new Request("https://internal.example/internal/fulfillment",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(obj)}));
 const intent=(kind,n,extra={})=>({kind,cycle:1,event_key:"nc012:"+kind+":"+n,now_ms:now+n,...extra});
 o.ledger.apply({event_key:"approved:synthetic:001",kind:"approved",cycle:1,at:new Date(now).toISOString()});
 return {o,db,call,intent,now,alarms};
}
test("G05 cannot generate without approved paid cycle",async()=>{
 const h=harness();h.o.ledger.apply({event_key:"stop:synthetic:001",kind:"operator_stop",cycle:1});
 const r=await h.call(h.intent("enqueue",1));
 assert.equal(r.status,403);
 assert.equal(h.o.fulfillment.snapshot().jobs.length,0);
});
test("G05 enqueue persists one job plus one alarm in the subscriber DO",async()=>{
 const h=harness();const a=await h.call(h.intent("enqueue",1));
 assert.equal(a.status,200);assert.equal(h.o.fulfillment.snapshot().jobs.length,1);
 assert.equal(h.alarms.length,1);
 const replay=await h.call(h.intent("enqueue",1));assert.equal(replay.status,200);
 assert.equal(h.o.fulfillment.snapshot().jobs.length,1);
 assert.equal(h.alarms.length,2);
});
test("G05 serial claim allows one owner and refuses second claim",async()=>{
 const h=harness();await h.call(h.intent("enqueue",1));
 assert.equal((await h.call(h.intent("claim",2))).status,200);
 assert.equal((await h.call(h.intent("claim",3))).status,409);
 assert.equal(h.o.fulfillment.current(1).attempts,1);
});
test("G05 failed generation goes to delayed retry, not silent success",async()=>{
 const h=harness();await h.call(h.intent("enqueue",1));await h.call(h.intent("claim",2));
 const r=await h.call(h.intent("failure",3));assert.equal(r.status,200);
 assert.equal(h.o.fulfillment.current(1).status,"retry");
 assert.equal(h.o.fulfillment.current(1).due_at_ms,h.now+3+300000);
 assert.equal((await h.call(h.intent("claim",4))).status,409);
});
test("G05 after twelve failures ends as dead with one owner-alert outbox",async()=>{
 const h=harness();await h.call(h.intent("enqueue",1));
 let time=h.now+2000;
 for(let i=1;i<=12;i++){
  let a=h.intent("claim",1000+i,{now_ms:time});assert.equal((await h.call(a)).status,200);
  time++;
  let b=h.intent("failure",2000+i,{now_ms:time});assert.equal((await h.call(b)).status,200);
  time=h.o.fulfillment.current(1).due_at_ms??time+1;
 }
 assert.equal(h.o.fulfillment.current(1).status,"dead");
 assert.equal(h.o.fulfillment.snapshot().alerts.length,1);
 assert.equal((await h.call(h.intent("claim",99,{now_ms:time+1}))).status,409);
});
test("G07 immutable package candidate creates blocked Resend outbox without email",async()=>{
 const h=harness();await h.call(h.intent("enqueue",1));await h.call(h.intent("claim",2));
 const sha="c".repeat(64),key="cp-pkg/"+"a".repeat(64)+"/1/"+sha;
 let r=await h.call(h.intent("package_ready",3,{package_sha256:sha,blob_key:key}));
 assert.equal(r.status,200);assert.equal((await r.json()).code,"OUTBOX_NOT_CONNECTED");
 assert.equal(h.o.fulfillment.snapshot().packages.length,1);
 assert.equal(h.o.fulfillment.snapshot().outbox[0].status,"blocked");
 assert.equal(h.o.fulfillment.snapshot().outbox[0].provider_receipt,null);
 assert.equal((await h.call(h.intent("package_ready",4,{package_sha256:sha,blob_key:key}))).status,409);
});
test("G07 rejects unverified blob references, no outbox",async()=>{
 const h=harness();await h.call(h.intent("enqueue",1));await h.call(h.intent("claim",2));
 assert.equal((await h.call(h.intent("package_ready",3,{package_sha256:"bad",blob_key:"bad"}))).status,403);
 assert.equal(h.o.fulfillment.snapshot().outbox.length,0);
});
test("G05 fails closed when alarm cannot be confirmed without losing durable queue",async()=>{
 const h=harness();h.o.ctx.storage.setAlarm=async()=>{throw Error("unavailable")};
 const r=await h.call(h.intent("enqueue",1));
 assert.equal(r.status,503);
 assert.equal(h.o.fulfillment.snapshot().jobs.length,1);
});
