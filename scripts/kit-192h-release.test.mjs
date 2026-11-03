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
test("H00 192h exactly independent of purchase calendar (00:05,12:00,23:55)",()=>{
 assert.equal(RELEASE_DELAY_MS,691200000);
 for(const hm of [[0,5],[12,0],[23,55]]){
  const approved=Date.parse("2026-11-03T"+String(hm[0]).padStart(2,"0")+":"+String(hm[1]).padStart(2,"0")+":00Z");
  const h=harness();h.approve(approved);
  assert.equal(h.ledger.state().release_at_ms-approved,192*H);
  assert.equal(h.ledger.authorizeRelease(approved+192*H-1,h.proof(approved+192*H-1)).code,"not_eligible");
  assert.equal(h.ledger.authorizeRelease(approved+192*H,h.proof(approved+192*H)).code,"eligible");
 }
});
test("H01 purchase earlier and webhook delayed 3 days never changes approved timestamp",()=>{
 const h=harness(),late=D+72*H;
 h.approve(D,late);
 assert.equal(h.ledger.state().release_at_ms,D+192*H);
 assert.equal(h.ledger.authorizeRelease(D+192*H,h.proof(D+192*H)).code,"eligible");
});
test("H02 duplicate Hotmart event idempotent, no extra release or email",()=>{
 const h=harness(),one=h.approve();
 const two=h.approve(D,D+H);
 assert.equal(one.code,"applied");assert.equal(two.code,"duplicate_event");
 assert.equal(h.ledger.eventCount(),1);
 assert.equal(h.ledger.outbox().length,0);
});
test("H03 refund at 191h59m is terminal and never emits token",async()=>{
 const h=harness();h.approve();
 const x=h.refund("PURCHASE_REFUNDED",D+192*H-60000);
 assert.equal(x.state,"revoked");
 const y=await h.ledger.prepareGrant(D+192*H,h.proof(D+192*H));
 assert.notEqual(y.code,"grant_pending_email");
 assert.equal(h.ledger.outbox().length,0);
});
test("H04 chargeback after release revokes previously valid token",async()=>{
 const h=harness();h.approve();
 const at=D+192*H;
 const r=await h.ledger.prepareGrant(at,h.proof(at),{randomBytes:()=>new Uint8Array(32).fill(7)});
 assert.equal(r.code,"grant_pending_email");
 assert.equal(await h.ledger.canDownload(at,r.token,h.proof(at)),true);
 assert.equal(await h.ledger.canDownload(at-1,r.token,h.proof(at-1)),false);
 h.refund("PURCHASE_CHARGEBACK",at+2*H);
 assert.equal(await h.ledger.canDownload(at+2*H,r.token,h.proof(at+2*H)),false);
 assert.equal(h.ledger.state().token_hash,null);
});
test("H05 approval after prior PROTEST must NOT reopen a revoked purchase",()=>{
 const h=harness();
 h.refund("PURCHASE_PROTEST",D);
 assert.equal(h.ledger.state().state,"revoked");
 h.approve(D,D+H);
 assert.equal(h.ledger.state().state,"revoked");
});
test("H06 no webhook, missing approved_date, or future timestamp deny release",async()=>{
 const h=harness();
 assert.equal(h.ledger.authorizeRelease(D+193*H,h.proof(D+193*H)).code,"not_eligible");
 assert.throws(()=>h.ledger.acceptEvent({event_key:"hotmart:approved-no-time",event_type:"PURCHASE_APPROVED"},D),/approved_at_absent/);
 assert.throws(()=>h.ledger.acceptEvent({event_key:"hotmart:approved-future",event_type:"PURCHASE_APPROVED",approved_at_ms:D+2*H},D),/approval_timestamp_in_future/);
});
test("H07 proof must come from trusted status check and cannot be stale",()=>{
 const h=harness();h.approve();
 const at=D+192*H;
 assert.equal(h.ledger.authorizeRelease(at,null).code,"verification_pending");
 assert.equal(h.ledger.authorizeRelease(at,{source:"browser",state:"APPROVED",checked_at_ms:at}).code,"verification_pending");
 assert.equal(h.ledger.authorizeRelease(at,{source:"hotmart_authoritative_readback",state:"REFUNDED",checked_at_ms:at}).code,"verification_pending");
 assert.equal(h.ledger.authorizeRelease(at,{source:"hotmart_authoritative_readback",state:"APPROVED",checked_at_ms:at-600000}).code,"verification_pending");
});
test("H08 stolen token cannot open early, token expiry enforced",async()=>{
 const h=harness();h.approve();
 const at=D+192*H;
 const r=await h.ledger.prepareGrant(at,h.proof(at),{randomBytes:()=>new Uint8Array(32).fill(2),ttlMs:1000*3600});
 assert.equal(await h.ledger.canDownload(at-1,r.token),false);
 assert.equal(await h.ledger.canDownload(at,r.token,h.proof(at)),true);
 assert.equal(await h.ledger.canDownload(at+1000*3600+1,r.token,h.proof(at+1000*3600+1)),false);
 assert.equal(await h.ledger.canDownload(at,"0".repeat(64),h.proof(at)),false);
});
test("H09 restart preserves approval, refund and immutable email receipt",async()=>{
 const h=harness();h.approve();
 const at=D+192*H;
 const r=await h.ledger.prepareGrant(at,h.proof(at),{randomBytes:()=>new Uint8Array(32).fill(9)});
 h.ledger.markEmailUncertain(at+1);
 const other=new KitReleaseLedger(h.storage,h.key);
 assert.equal(other.outbox()[0].status,"uncertain");
 assert.equal(other.acceptEmailReceipt(at+2,"resend:receipt-0001").code,"accepted");
 assert.equal(h.ledger.outbox()[0].provider_receipt,"resend:receipt-0001");
 assert.throws(()=>h.ledger.acceptEmailReceipt(at+3,"resend:receipt-different"),/receipt_conflict/);
 assert.equal(await other.canDownload(at,r.token,h.proof(at)),true);
});
test("H10 internal DO rejects request without trusted bridge and uses own alarm",async()=>{
 const h=harness(),ctx={storage:h.storage,id:{toString:()=>"a".repeat(64)}};
 const obj=new KitReleaseOrderDO(ctx,{INTERNAL_DO_SIGNING_KEY:"test-only-internal-do-secret"});
 const req=(key)=>new Request("https://private.example/internal/event",{method:"POST",headers:{"x-internal-do-key":key,"content-type":"application/json"},body:JSON.stringify({
 event_key:"hotmart:approved-transaction-011",event_type:"PURCHASE_APPROVED",approved_at_ms:Date.now()-1000
 })});
 assert.equal((await obj.fetch(req("wrong"))).status,403);
 assert.equal((await obj.fetch(req("test-only-internal-do-secret"))).status,200);
 assert.ok(h.storage.alarms.length>=1);
 // Alarm must only queue eligible claim, never produce a bearer token.
 assert.equal(h.ledger.state().token_hash,null);
});
test("H11 authenticated routing derives DO from product+transaction, not buyer email",async()=>{
 const ids=[];const env={HOTMART_HOTTOK:"test-hotmart-hottok-very-secret",
  PURCHASE_DO_ROUTING_KEY:"test-kit-do-route-secret-123456789012345",
  HOTMART_KIT_PRODUCT_IDS:"8704733,8704826,8704851,8704861,8704871",
  PURCHASE_RELEASE_DO:{idFromName(n){ids.push(n);return {toString:()=>("b".repeat(64))};},get(n){return {id:n}}}};
 function req({email="a@test.invalid",tok=env.HOTMART_HOTTOK,product=8704733}={}){
  return new Request("https://zevanory.api.br/api/webhooks/hotmart",{method:"POST",headers:{"x-hotmart-hottok":tok,"content-type":"application/json"},
   body:JSON.stringify({version:"2.0.0",event:"PURCHASE_APPROVED",data:{product:{id:product},purchase:{transaction:"HP1234567890111",approved_date:D},buyer:{email}}})});
 }
 const x=await resolveVerifiedKitPurchase(req(),env);
 const y=await resolveVerifiedKitPurchase(req({email:"different@test.invalid"}),env);
 assert.equal(x.opaqueOrderId,y.opaqueOrderId);
 assert.match(ids[0],/^kit-verified:[a-f0-9]{64}$/);
 const before=ids.length;
 await assert.rejects(resolveVerifiedKitPurchase(req({tok:"evil"}),env),/unauthenticated_hotmart/);
 assert.equal(ids.length,before);
 await assert.rejects(resolveVerifiedKitPurchase(req({product:12345}),env),/invalid_kit_purchase/);
});
