import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialProofSnapshot,verifyFinancialProofSnapshot,readFinancialProofSnapshot,projectProductionOnlyStatus,COMMERCIAL_PROOF_KV_KEY} from "../worker/commercial-metrics-projection.mjs";
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
 assert.equal(out.gate,"G3");
});
test("bounded KV snapshot read never claims verification on corrupt or expired data",async()=>{
 const snap=createFinancialProofSnapshot(env,audited,{now});
 const kv={get:async key=>key===COMMERCIAL_PROOF_KV_KEY?JSON.stringify(snap):null};
 const read=await readFinancialProofSnapshot({...env,ZEVANORY_PRIVATE_ARTIFACTS:kv},{now});
 assert.equal(read.verified,true);
 assert.equal(await readFinancialProofSnapshot({...env,ZEVANORY_PRIVATE_ARTIFACTS:kv},{now:now+70*60000}),null);
 assert.equal(createFinancialProofSnapshot(env,{code:409,result:{...audited.result,ambiguous:1}},{now}).verified,false);
});
