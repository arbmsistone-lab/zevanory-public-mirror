import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {ContentProntoSubscriberDO} from "../worker/cp-durable-ledger.mjs";
import {brasiliaCivilDate,CP_CAMPAIGN_REMINDER_DAYS} from "../worker/cp-nc014-campaign.mjs";
function setup(){
 const db=new DatabaseSync(":memory:");
 const sql={exec(query,...args){
  const q=query.trim();
  if(/^SELECT\b/i.test(q))return {toArray:()=>db.prepare(q).all(...args)};
  if(/^CREATE\s+(TABLE|INDEX)\b/i.test(q)){db.exec(q);return {toArray:()=>[]}};
  db.prepare(q).run(...args);return {toArray:()=>[]};
 }};
 const storage={sql,setAlarm:async()=>true,transactionSync(fn){
  db.exec("BEGIN IMMEDIATE");try{const r=fn();db.exec("COMMIT");return r}
  catch(e){db.exec("ROLLBACK");throw e}
 }};
 const obj=new ContentProntoSubscriberDO({storage,id:{toString:()=>("1a".repeat(32))}});
 const at=Date.parse("2026-11-01T12:00:00.000Z");
 const approve=(cycle)=>obj.ledger.apply({kind:"approved",cycle,event_key:"approved:l1:000"+cycle,at:new Date(at+(cycle-1)*30*86400000).toISOString()});
 const request=(cycle=1)=>obj.ledger.apply({kind:"form_token_issued",cycle,event_key:"form:issued:l1:"+cycle,token_sha256:"a".repeat(64),expires_at_ms:at+50*86400000,at:new Date(at).toISOString()});
 return {db,obj,at,approve,request};
}
test("[do][camp-pago] approved cycle opens month only; no synthetic paid customer, email or KV",()=>{
 const h=setup();h.approve(1);
 assert.equal(h.obj.ledger.current().status,"active");
 assert.deepEqual(h.obj.campaign.snapshot().requests.map(x=>x.status),["awaiting_delivery"]);
 assert.equal(h.obj.campaign.snapshot().reminders.length,0);
 assert.equal(h.obj.fulfillment.snapshot().jobs.length,0);
});
test("[do][camp-lembretes] no reminders until provider-confirmed form request",()=>{
 const h=setup();h.approve(1);h.request();
 assert.equal(h.obj.campaign.dueReminders(h.at+30*86400000).pending,0);
 assert.throws(()=>h.obj.campaign.confirmRequest(1,"re_123456789","unverified",h.at),/request_proof_missing/);
 assert.equal(h.obj.campaign.snapshot().requests[0].status,"awaiting_delivery");
});
test("[do][camp-lembretes] days 3,7,14 append unique pending reminders; owner on 7/14",()=>{
 const h=setup();h.approve(1);h.request();
 const proof=h.obj.campaign.confirmRequest(1,"re_123456789","provider-get-verified",h.at);
 assert.equal(proof.ok,true);
 for(const [day,wanted] of [[2,0],[3,1],[7,2],[14,3],[50,3]]){
  const r=h.obj.campaign.dueReminders(h.at+day*86400000);
  assert.equal(r.pending,wanted,"day "+day);
 }
 assert.deepEqual(h.obj.campaign.snapshot().reminders.map(x=>x.day),[3,7,14]);
 assert.deepEqual(h.obj.campaign.snapshot().reminders.map(x=>x.owner_alert),[0,1,1]);
 assert.deepEqual([...CP_CAMPAIGN_REMINDER_DAYS],[3,7,14]);
});
test("[do][camp-form] valid form consumes token and cancels pending reminders without Resend call",()=>{
 const h=setup();h.approve(1);h.request();
 h.obj.campaign.confirmRequest(1,"re_123456789","provider-get-verified",h.at);
 h.obj.campaign.dueReminders(h.at+7*86400000);
 h.obj.ledger.apply({kind:"form_submitted",cycle:1,event_key:"form:submit:l1:0001",token_sha256:"a".repeat(64),form_sha256:"b".repeat(64),form_json:"{\"campanha\":\"campanha valida\"}",at:new Date(h.at+8*86400000).toISOString()});
 assert.equal(h.obj.campaign.snapshot().requests[0].status,"submitted");
 assert.equal(h.obj.campaign.snapshot().reminders.every(x=>x.status==="canceled"),true);
 assert.equal(h.obj.campaign.dueReminders(h.at+20*86400000).pending,0);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions").get().n,1);
});
test("[do][camp-renovacao] unpaid month is never inferred; paid renewal without form creates available credit",()=>{
 const h=setup();h.approve(1);h.approve(2);
 assert.equal(h.obj.ledger.current().cycle,2);
 assert.deepEqual(h.obj.campaign.snapshot().requests.map(x=>x.status),["awaiting_delivery","awaiting_delivery"]);
 assert.deepEqual(h.obj.campaign.snapshot().credits.map(x=>x.cycle),[1]);
 assert.equal(h.obj.fulfillment.snapshot().jobs.length,0);
});
test("[do][camp-credito] max 2 credits, third kept in pending refund intent not falsely paid",()=>{
 const h=setup();
 for(let cycle=1;cycle<=4;cycle++)h.approve(cycle);
 assert.deepEqual(h.obj.campaign.snapshot().credits.map(x=>x.cycle),[2,3]);
 const req=h.obj.campaign.snapshot().refund_intents;
 assert.equal(req.length,1);assert.equal(req[0].cycle,1);assert.equal(req[0].status,"pending");
 assert.equal(h.obj.ledger.current().cycle,4);
});
test("[do][camp-cancelamento] stop clears future reminders, never marks email sent",()=>{
 const h=setup();h.approve(1);h.request();
 h.obj.campaign.confirmRequest(1,"re_123456789","provider-get-verified",h.at);
 h.obj.campaign.dueReminders(h.at+3*86400000);
 h.obj.ledger.apply({kind:"operator_stop",cycle:1,event_key:"operator:stop:l1:0001",at:new Date(h.at+4*86400000).toISOString()});
 assert.equal(h.obj.campaign.snapshot().requests[0].status,"stopped");
 assert.equal(h.obj.campaign.snapshot().reminders[0].status,"canceled");
 assert.equal(h.obj.campaign.dueReminders(h.at+14*86400000).pending,0);
});
test("[do][camp-fuso] Sao Paulo civil-day boundary and leap day are deterministic",()=>{
 assert.equal(brasiliaCivilDate(Date.parse("2024-02-29T02:59:59.000Z")),"2024-02-28");
 assert.equal(brasiliaCivilDate(Date.parse("2024-02-29T03:00:00.000Z")),"2024-02-29");
 assert.equal(brasiliaCivilDate(Date.parse("2026-01-01T02:59:59.000Z")),"2025-12-31");
 assert.equal(brasiliaCivilDate(Date.parse("2026-01-01T03:00:00.000Z")),"2026-01-01");
});
