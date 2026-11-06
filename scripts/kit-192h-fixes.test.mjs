import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {KitReleaseLedger,KitReleaseError,KitReleaseOrderDO,RELEASE_DELAY_MS} from "../worker/kit-release-192h.mjs";
import {resolveVerifiedKitPurchase} from "../worker/kit-hotmart-identity.mjs";
const D=Date.parse("2026-11-03T23:55:00.000Z");
const H=3600_000;
function harness(){
 const db=new DatabaseSync(":memory:");
 const sql={exec(q,...args){let s=q.trim();
  if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
  if(/^CREATE\s+(?:TABLE|INDEX)/i.test(s)){db.exec(s);return {toArray:()=>[]}};
  db.prepare(s).run(...args);return {toArray:()=>[]};
 }};
 const storage={sql,alarms:[],transactionSync(fn){db.exec("BEGIN IMMEDIATE");try{const v=fn();db.exec("COMMIT");return v}catch(e){db.exec("ROLLBACK");throw e}},
 async setAlarm(t){this.alarms.push(t)},async getAlarm(){return this.alarms.at(-1)??null}};
 const key="kr:"+"a".repeat(64);
 const ledger=new KitReleaseLedger(storage,key);
 const approve=(at=D,arrived=at)=>ledger.acceptEvent({event_type:"PURCHASE_APPROVED",event_key:"hotmart:approved-transaction-001",approved_at_ms:at},arrived);
 const refund=(type="PURCHASE_REFUNDED",when=D+180*H)=>ledger.acceptEvent({event_type:type,event_key:"hotmart:"+type.toLowerCase()+"-001"},when);
 const proof=(at=D+192*H)=>({source:"hotmart_authoritative_readback",state:"APPROVED",refund_request_open:false,order_opaque:key,checked_at_ms:at});
 return {db,storage,ledger,approve,refund,proof,key};
}

test("F1: provider refund without local webhook denies access, stale and wrong purchase also denied",async()=>{
 const h=harness(),at=D+192*H;
 h.approve();
 const grant=await h.ledger.prepareGrant(at,h.proof(at),{randomBytes:()=>new Uint8Array(32).fill(12)});
 assert.equal(grant.code,"grant_pending_email");
 assert.equal(await h.ledger.canDownload(at,grant.token,h.proof(at)),true);
 assert.equal(await h.ledger.canDownload(at,grant.token),false,"missing verifier");
 assert.equal(await h.ledger.canDownload(at,grant.token,{...h.proof(at),state:"REFUNDED"}),false,"provider refund not yet webhooked");
 assert.equal(await h.ledger.canDownload(at,grant.token,{...h.proof(at),refund_request_open:true}),false,"provider refund request pending");
 assert.equal(await h.ledger.canDownload(at,grant.token,{...h.proof(at),checked_at_ms:at-600000}),false,"stale readback");
 assert.equal(await h.ledger.canDownload(at,grant.token,{...h.proof(at),order_opaque:"kr:"+"f".repeat(64)}),false,"wrong purchase");
});
test("F2: no provider verifier stops after <=48 retries and emits one owner alert, 30-day bounded",async()=>{
 const h=harness();h.approve();
 const ctx={storage:h.storage,id:{toString:()=> "a".repeat(64)}};
 const obj=new KitReleaseOrderDO(ctx,{KIT_DEFERRED_192H_ENABLED:"true"});
 let t=D+192*H,calls=0;
 for(let day=0;day<30;day++){
  const bound=t+24*H;
  while(t<=bound && obj.ledger.state().state==="waiting"){
   await obj.alarm(t);calls++;
   const next=h.storage.alarms.at(-1);
   if(!next||next<=t)break;
   t=next;
  }
  t=Math.max(t,bound+1);
 }
 assert.ok(calls<=60,"no runaway DO invocation: "+calls);
 assert.equal(obj.ledger.state().state,"stalled");
 assert.equal(obj.ledger.alarmPolicy().attempts,48);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM kit_owner_alert_outbox").get().n,1);
 const before=h.storage.alarms.length;
 await obj.alarm(t+30*24*H);
 assert.equal(h.storage.alarms.length,before,"stalled order never polls again");
});
test("F2: provider-approved claim stops alarm instead of polling forever",async()=>{
 const h=harness();h.approve();
 const at=D+192*H,ctx={storage:h.storage,id:{toString:()=> "a".repeat(64)}};
 let readbacks=0;
 const obj=new KitReleaseOrderDO(ctx,{KIT_DEFERRED_192H_ENABLED:"true",HOTMART_STATUS_VERIFIER:{
  async fetch(){readbacks++;return Response.json(h.proof(at))}}});
 await obj.alarm(at);
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM kit_eligibility_outbox").get().n,1);
 assert.equal(obj.ledger.alarmPolicy().status,"queued");
 assert.equal(h.storage.alarms.length,0);
 await obj.alarm(at+24*H);
 assert.equal(h.storage.alarms.length,0);
 assert.equal(readbacks,1,"verified delivery must never perform another provider readback");
});
test("F3: refund request is reversible ONLY with owner version + authoritative clear proof",async()=>{
 const h=harness();h.approve();
 const at=D+180*H;
 h.refund("REFUND_REQUESTED",at);
 assert.equal(h.ledger.state().state,"held_refund_request");
 assert.equal(h.ledger.authorizeRelease(at+12*H,h.proof(at+12*H)).code,"not_eligible");
 const version=h.ledger.state().version;
 const command={event_key:"operator:refund-request-withdrawn-0001",expected_version:version};
 const approved=h.proof(at+1);
 assert.throws(()=>h.ledger.resumeRefundRequest(command,at+1,{...approved,refund_request_open:true}),/refund_resolution_not_verified/);
 assert.throws(()=>h.ledger.resumeRefundRequest({...command,expected_version:version-1},at+1,approved),/stale_version/);
 assert.equal(h.ledger.resumeRefundRequest(command,at+1,approved).code,"resumed");
 assert.equal(h.ledger.state().state,"waiting");
 assert.equal(h.ledger.resumeRefundRequest(command,at+1,approved).code,"duplicate_event");
});
test("F3: internal operator route must authenticate and reject terminal refund",async()=>{
 const h=harness();h.approve();h.refund("PURCHASE_CHARGEBACK",D+180*H);
 assert.equal(h.ledger.state().state,"revoked");
 assert.throws(()=>h.ledger.resumeRefundRequest({event_key:"operator:force-resume-0000001",expected_version:h.ledger.state().version},D+180*H+1,h.proof(D+180*H+1)),/not_held_refund/);
 const key="trusted-test-key",ctx={storage:h.storage,id:{toString:()=> "a".repeat(64)}};
 const obj=new KitReleaseOrderDO(ctx,{KIT_DEFERRED_192H_ENABLED:"true",INTERNAL_DO_SIGNING_KEY:key,AUTHENTICATED_OWNER_OPERATOR_KEY:"owner-test-key"});
 const req=(owner)=>new Request("https://internal.example/internal/operator/resume-refund",{method:"POST",
  headers:{"x-internal-do-key":key,"x-operator-key":owner,"content-type":"application/json"},
  body:JSON.stringify({event_key:"operator:force-resume-0000001",expected_version:h.ledger.state().version})});
 assert.equal((await obj.fetch(req("wrong"))).status,403);
});
