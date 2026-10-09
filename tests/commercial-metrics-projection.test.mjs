import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialProofSnapshot,verifyFinancialProofSnapshot,readFinancialProofSnapshot,projectProductionOnlyStatus,COMMERCIAL_PROOF_KV_KEY,persistClassificationSnapshot,describeFinancialProofSnapshot,countProductionCheckouts,recordLaunchEpoch,LAUNCH_EPOCH_KV_KEY,refreshFinancialProofSnapshot} from "../worker/commercial-metrics-projection.mjs";
const SHA="a".repeat(40);
const env={ZEVANORY_RELEASE_SHA:SHA};
const now=Date.parse("2026-10-08T19:15:00Z");
const audited={code:200,result:{complete:true,ambiguous:0,production_confirmed:0,production_paid_orders:0,production_payment_events:0,production_refund_events:0,
  certification_events:22,orders:{certification:22,noncertified_unverified:28},payment_ids:{ambiguo:["should-not-be-copied"]}}};
const source={gate:"G3",experiment:{status:"commercial_live_payment_observed"},metrics:{orders:50,payments_confirmed:21,refunds_confirmed:1,checkouts_started:10,page_views:800},economics:{gross_revenue_brl:197}};
test("fixture and pilot payment counts never inflate the production-only status",()=>{
 const snap=createFinancialProofSnapshot(env,audited,{now});
 assert.equal(verifyFinancialProofSnapshot(snap,env,{now}),true);
 const status=projectProductionOnlyStatus(source,snap,{now,env});
 assert.deepEqual([status.metrics.orders,status.metrics.payments_confirmed,status.metrics.refunds_confirmed,status.metrics.checkouts_started],[0,0,0,0]);
 assert.equal(status.metrics.page_views,800);
 assert.equal(status.gate,"G2");
 assert.equal(status.experiment.status,"technical_ready_commercial_not_started");
 assert.equal(status.economics,null);
 assert.equal(status.commercial_metrics_provenance.state,"PROVEN");
 assert.equal(status.test_certification.events,22);
 assert.equal(status.legacy_technical_unverified_counts.orders,50);
 assert.equal(JSON.stringify(snap).includes("should-not-be-copied"),false);
});
test("unverified, stale or previous SHA snapshots never turn legacy counts into production",()=>{
 const good=createFinancialProofSnapshot(env,audited,{now});
 for(const proof of [null,{...good,ambiguous:1},{...good,release_sha:"b".repeat(40)},{...good,measured_at:new Date(now-70*60000).toISOString()}]){
  const status=projectProductionOnlyStatus(source,proof,{now,env});
  assert.equal(status.metrics.orders,0);
  assert.equal(status.metrics.payments_confirmed,0);
  assert.equal(status.gate,"G2");
  assert.equal(status.commercial_metrics_provenance.state,"UNVERIFIED_FAIL_CLOSED");
 }
});
test("only provider-confirmed real production evidence contributes paid and refund counts",()=>{
 const data={...audited,result:{...audited.result,production_confirmed:4,production_paid_orders:3,production_payment_events:3,production_refund_events:1,certification_events:22}};
 const snap=createFinancialProofSnapshot(env,data,{now});
 const out=projectProductionOnlyStatus(source,snap,{now,env});
 assert.equal(out.metrics.orders,3);
 assert.equal(out.metrics.payments_confirmed,3);
 assert.equal(out.metrics.refunds_confirmed,1);
 assert.equal(out.gate,"G2");
 assert.equal(out.experiment.status,"production_payment_observed_commercial_locked");
 assert.equal(out.commercial_metrics_provenance.commercial_release_allowed,false);
});
test("bounded KV snapshot read never claims verification on corrupt or expired data",async()=>{
 const snap=createFinancialProofSnapshot(env,audited,{now});
 const kv={get:async key=>key===COMMERCIAL_PROOF_KV_KEY?JSON.stringify(snap):null};
 const read=await readFinancialProofSnapshot({...env,ZEVANORY_PRIVATE_ARTIFACTS:kv},{now});
 assert.equal(read.verified,true);
 assert.equal(await readFinancialProofSnapshot({...env,ZEVANORY_PRIVATE_ARTIFACTS:kv},{now:now+70*60000}),null);
 assert.equal(createFinancialProofSnapshot(env,{code:409,result:{...audited.result,ambiguous:1}},{now}).verified,false);
});

test("inconsistent provider event counts fail closed before KV evidence",()=>{
 const invalid=[
  {production_confirmed:1,production_payment_events:2,production_refund_events:0,production_paid_orders:1},
  {production_confirmed:2,production_payment_events:1,production_refund_events:2,production_paid_orders:1},
  {production_confirmed:2,production_payment_events:1,production_refund_events:0,production_paid_orders:2}
 ];
 for(const counts of invalid){
  const snap=createFinancialProofSnapshot(env,{...audited,result:{...audited.result,...counts}},{now});
  assert.equal(snap.verified,false);
  assert.equal(verifyFinancialProofSnapshot(snap,env,{now}),false);
  const out=projectProductionOnlyStatus(source,snap,{now,env});
  assert.equal(out.gate,"G2");
  assert.equal(out.commercial_metrics_provenance.state,"UNVERIFIED_FAIL_CLOSED");
 }
});
test("tampered persisted snapshot with more paid orders than payments is rejected",()=>{
 const good=createFinancialProofSnapshot(env,{...audited,result:{...audited.result,production_confirmed:2,production_paid_orders:1,production_payment_events:1,production_refund_events:1}},{now});
 assert.equal(good.verified,true);
 const forged={...good,production:{...good.production,paid_orders:2}};
 assert.equal(verifyFinancialProofSnapshot(forged,env,{now}),false);
});

test("authenticated classification persists only verified snapshots and describes them without IDs",async()=>{
 const map={};const kv={get:async k=>map[k]??null,put:async(k,v)=>{map[k]=v;}};
 const e={...env,ZEVANORY_PRIVATE_ARTIFACTS:kv};
 assert.equal((await persistClassificationSnapshot(e,{code:200,result:{...audited.result,ambiguous:1}},{now})).ok,false);
 assert.equal(map[COMMERCIAL_PROOF_KV_KEY],undefined);
 assert.equal((await persistClassificationSnapshot(e,audited,{now})).ok,true);
 const d=await describeFinancialProofSnapshot(e,{now});
 assert.deepEqual([d.present,d.verified_flag,d.release_matches,d.accepted,d.age_minutes],[true,true,true,true,0]);
 assert.equal(JSON.stringify(d).includes("should-not-be-copied"),false);
 assert.equal((await readFinancialProofSnapshot(e,{now})).verified,true);
 assert.equal((await describeFinancialProofSnapshot({...e,ZEVANORY_RELEASE_SHA:"b".repeat(40)},{now})).accepted,false);
});

test("release flag and gate follow the real release state, never a constant",()=>{
 const snap=createFinancialProofSnapshot(env,audited,{now,checkoutsStarted:4});
 const closed=projectProductionOnlyStatus(source,snap,{now,env});
 assert.equal(closed.commercial_metrics_provenance.commercial_release_allowed,false);
 assert.equal(closed.gate,"G2");
 const live=projectProductionOnlyStatus(source,snap,{now,env,salesRelease:true});
 assert.equal(live.commercial_metrics_provenance.commercial_release_allowed,true);
 assert.equal(live.gate,"G3");
 assert.equal(live.experiment.status,"commercial_live_awaiting_first_payment");
 assert.equal(live.metrics.checkouts_started,4);
 assert.equal(live.commercial_metrics_provenance.checkouts_measured,true);
 // Sales switch open but the proof is stale, unverified or from another release: fail closed.
 for(const proof of [null,{...snap,ambiguous:1},{...snap,measured_at:new Date(now-66*60000).toISOString()},{...snap,release_sha:"b".repeat(40)}]){
  const out=projectProductionOnlyStatus(source,proof,{now,env,salesRelease:true});
  assert.equal(out.commercial_metrics_provenance.commercial_release_allowed,false);
  assert.equal(out.gate,"G2");
  assert.equal(out.metrics.checkouts_started,0);
 }
 assert.equal(projectProductionOnlyStatus(source,snap,{now,env,salesRelease:"true"}).commercial_metrics_provenance.commercial_release_allowed,false);
});
test("legacy checkouts never leak; snapshot without the field still verifies with 0",()=>{
 const snap=createFinancialProofSnapshot(env,audited,{now});
 assert.equal(snap.production.checkouts_started,null);
 assert.equal(verifyFinancialProofSnapshot(snap,env,{now}),true);
 const out=projectProductionOnlyStatus(source,snap,{now,env,salesRelease:true});
 assert.equal(out.metrics.checkouts_started,0);
 assert.equal(out.commercial_metrics_provenance.checkouts_measured,false);
 assert.equal(out.legacy_technical_unverified_counts.checkouts_started,10);
 assert.equal(verifyFinancialProofSnapshot({...snap,production:{...snap.production,checkouts_started:-1}},env,{now}),false);
});
test("production checkouts count only non-certification orders since the launch epoch",async()=>{
 const map=new Map();
 const kv={get:async k=>map.get(k)??null,put:async(k,v)=>{map.set(k,v);}};
 const queries=[];
 const sqlFactory=()=>({query:async(text,params)=>{queries.push({text,params});return [{n:7}];}});
 const e={...env,DATABASE_URL:"postgres://x",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 assert.equal(await countProductionCheckouts(e,{sqlFactory}),0);
 assert.equal(queries.length,0);
 assert.deepEqual(await recordLaunchEpoch(e,{enabled:true,authorized:false,at:"2026-10-09T15:00:00.000Z"}),{recorded:false});
 assert.deepEqual(await recordLaunchEpoch(e,{enabled:false,authorized:true,at:"2026-10-09T15:00:00.000Z"}),{recorded:false});
 assert.equal((await recordLaunchEpoch(e,{enabled:true,authorized:true,at:"2026-10-09T15:00:00.000Z"})).recorded,true);
 assert.equal((await recordLaunchEpoch(e,{enabled:true,authorized:true,at:"2026-10-10T15:00:00.000Z"})).recorded,false);
 assert.equal(JSON.parse(map.get(LAUNCH_EPOCH_KV_KEY)).at,"2026-10-09T15:00:00.000Z");
 assert.equal(await countProductionCheckouts(e,{sqlFactory}),7);
 assert.match(queries[0].text,/coalesce\(certification_pilot,false\)=false/);
 assert.match(queries[0].text,/created_at >= \$1/);
 assert.deepEqual(queries[0].params,["2026-10-09T15:00:00.000Z"]);
 assert.equal(await countProductionCheckouts(e,{sqlFactory:()=>({query:async()=>{throw new Error("db");}})}),null);
});


test("isolated Cloudflare renewal is independent of an existing verified snapshot",async()=>{
 const m=new Map(),kv={get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);}};
 const environment={...env,DATABASE_URL:"postgres://test",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const at=now+70*60000;
 const prior=createFinancialProofSnapshot(environment,audited,{now:at-20*60000});
 m.set(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(prior));
 let calls=0;
 const audit=async()=>{calls++;return audited;},countCheckouts=async()=>0;
 const recent=await refreshFinancialProofSnapshot(environment,{now:at,sqlFactory:()=>{},audit,countCheckouts});
 assert.equal(recent.reason,"recent_snapshot");
 assert.equal(calls,0);
 const forced=await refreshFinancialProofSnapshot(environment,{now:at,sqlFactory:()=>{},audit,countCheckouts,force:true});
 assert.equal(forced.ok,true);
 assert.equal(forced.reason,"proven");
 assert.equal(calls,1);
 const refreshed=await readFinancialProofSnapshot(environment,{now:at+5*60000});
 assert.ok(refreshed);
 assert.equal(refreshed.measured_at,new Date(at).toISOString());
});

test("an unverified recent snapshot never suppresses a new financial GET audit",async()=>{
 const m=new Map(),kv={get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);}};
 const environment={...env,DATABASE_URL:"postgres://test",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const bad={...createFinancialProofSnapshot(environment,audited,{now}),verified:false};
 m.set(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(bad));
 let attempts=0;
 const result=await refreshFinancialProofSnapshot(environment,{now:now+120000,sqlFactory:()=>{},
   audit:async()=>{attempts++;return audited;},countCheckouts:async()=>0});
 assert.equal(attempts,1);
 assert.equal(result.ok,true);
 assert.equal((await readFinancialProofSnapshot(environment,{now:now+120000})).verified,true);
});

test("transient provider 503 preserves only still-valid proof, but 409 ambiguity invalidates",async()=>{
 const m=new Map(),kv={get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);}};
 const environment={...env,DATABASE_URL:"postgres://test",ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const accepted=createFinancialProofSnapshot(environment,audited,{now});
 m.set(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(accepted));
 const transient=await refreshFinancialProofSnapshot(environment,{now:now+60000,sqlFactory:()=>{},force:true,
   audit:async()=>({code:503,result:{error:"provider_unavailable"}}),countCheckouts:async()=>0});
 assert.equal(transient.ok,false);
 assert.equal(transient.reason,"audit_unavailable");
 assert.equal(JSON.parse(m.get(COMMERCIAL_PROOF_KV_KEY)).verified,true);
 const conflict=await refreshFinancialProofSnapshot(environment,{now:now+120000,sqlFactory:()=>{},force:true,
   audit:async()=>({code:409,result:{...audited.result,ambiguous:1}}),countCheckouts:async()=>0});
 assert.equal(conflict.ok,false);
 assert.equal(conflict.reason,"ambiguous");
 assert.equal(await readFinancialProofSnapshot(environment,{now:now+120000}),null);
});
