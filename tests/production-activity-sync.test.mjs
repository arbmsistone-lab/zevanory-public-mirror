import test from "node:test";
import assert from "node:assert/strict";
import {syncProductionActivity} from "../worker/production-activity-sync.mjs";
import {createFinancialProofSnapshot,COMMERCIAL_PROOF_KV_KEY,LAUNCH_EPOCH_KV_KEY} from "../worker/commercial-metrics-projection.mjs";
const SHA="a".repeat(40),now=Date.parse("2026-10-09T21:55:00Z");
const OID="11111111-1111-4111-8111-111111111111";
const audited={code:200,result:{complete:true,ambiguous:0,production_confirmed:1,production_paid_orders:1,
 production_payment_events:1,production_refund_events:0,certification_events:22,
 orders:{certification:22,noncertified_unverified:2}}};
function fixture({verified=true,paidAt="2026-10-09T21:40:00Z",status="paid"}={}){
 const map=new Map(),calls=[];
 const kv={
  get:async(k)=>map.get(k)||null,
  put:async(k,v)=>{map.set(k,v)}
 };
 const env={ZEVANORY_PRIVATE_ARTIFACTS:kv,ZEVANORY_RELEASE_SHA:SHA,DATABASE_URL:"postgres://not-used"};
 map.set(LAUNCH_EPOCH_KV_KEY,JSON.stringify({at:"2026-10-09T20:19:12Z"}));
 const snap=createFinancialProofSnapshot(env,audited,{now:now-5*60000});
 if(verified)map.set(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(snap));
 const sqlFactory=()=>({query:async(text,params)=>{
  calls.push({text,params});
  return [{ref:OID,created_at:"2026-10-09T20:25:53Z",status,amount:"37.00",paid_event_at:paidAt}];
 }});
 return {map,env,sqlFactory,calls};
}
test("read-only producer reports only checkout and reconciled provider payment, idempotent",async()=>{
 const x=fixture();
 const a=await syncProductionActivity(x.env,{sqlFactory:x.sqlFactory,now});
 assert.deepEqual([a.ok,a.seen,a.emitted,a.finance,a.proof_accepted],[true,1,2,1,true]);
 assert.match(x.calls[0].text,/certification_pilot is false/);
 assert.match(x.calls[0].text,/provider_status in/);
 assert.deepEqual(x.calls[0].params,["2026-10-09T20:19:12.000Z"]);
 const values=[...x.map].filter(([k])=>k.startsWith("zpc-activity:v1:event:")).map(([,v])=>JSON.parse(v));
 assert.equal(values.length,2);
 assert.equal(values.find(x=>x.type==="payment_confirmed").amountCents,3700);
 assert.equal(values.find(x=>x.type==="payment_confirmed").financialProof,"provider-get-verified");
 assert.ok(!JSON.stringify(values).includes(OID));
 const b=await syncProductionActivity(x.env,{sqlFactory:x.sqlFactory,now:now+15000});
 assert.equal(b.emitted,0);
});
test("unverified or stale financial proof cannot create revenue events",async()=>{
 for(const opts of [{verified:false},{paidAt:"2026-10-09T21:52:00Z"}]){
  const x=fixture(opts);
  const result=await syncProductionActivity(x.env,{sqlFactory:x.sqlFactory,now});
  assert.equal(result.finance,0);
  assert.equal(result.emitted,1);
 }
});
test("status not paid, invalid amount, absent launch epoch and database error fail safely",async()=>{
 const unpaid=fixture({status:"pending"});
 assert.equal((await syncProductionActivity(unpaid.env,{sqlFactory:unpaid.sqlFactory,now})).finance,0);
 const x=fixture();x.map.delete(LAUNCH_EPOCH_KV_KEY);
 const noEpoch=await syncProductionActivity(x.env,{sqlFactory:x.sqlFactory,now});
 assert.equal(noEpoch.idle,"no_launch_epoch");
 const broken=fixture();
 const failure=await syncProductionActivity(broken.env,{sqlFactory:()=>({query:async()=>{throw Error("PII@customer")}}),now});
 assert.deepEqual(failure,{ok:false,reason:"database_read_unavailable"});
});
