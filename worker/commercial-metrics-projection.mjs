import { collectFinancialProvenanceReadOnly } from "./internal-financial-audit.mjs";
export const COMMERCIAL_PROOF_KV_KEY="zpc-production-financial-metrics:v1";
const MAX_AGE_MS=65*60*1000;
const MIN_REFRESH_MS=50*60*1000;
const isCount=n=>Number.isInteger(n)&&n>=0&&n<=100000000;
const cleanCount=x=>isCount(x)?x:0;
export const LAUNCH_EPOCH_KV_KEY="sales:launch-epoch:v1";
// First owner-authorized opening of sales. Written once, never moved: production
// checkouts are counted only from this instant (no epoch => sales never opened => 0).
export async function recordLaunchEpoch(env,salesSwitch){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv?.get||!kv?.put||salesSwitch?.enabled!==true||salesSwitch?.authorized!==true)return {recorded:false};
  const at=Date.parse(String(salesSwitch.at||""));
  if(!Number.isFinite(at))return {recorded:false};
  try{if(await kv.get(LAUNCH_EPOCH_KV_KEY))return {recorded:false,reason:"exists"};}catch{return {recorded:false};}
  await kv.put(LAUNCH_EPOCH_KV_KEY,JSON.stringify({at:new Date(at).toISOString(),recorded_at:new Date().toISOString()}));
  return {recorded:true};
}
// Production-only checkouts: non-certification orders created since the launch epoch.
// Certification/sandbox orders and every pre-launch internal order are excluded.
export async function countProductionCheckouts(env,{sqlFactory}={}){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  let epoch=null;
  try{epoch=JSON.parse(String(await kv?.get?.(LAUNCH_EPOCH_KV_KEY)||"null"));}catch{return null;}
  const at=Date.parse(String(epoch?.at||""));
  if(!epoch)return 0;
  if(!Number.isFinite(at)||!sqlFactory||!env?.DATABASE_URL)return null;
  try{
    const rows=await sqlFactory(env.DATABASE_URL).query(
      "select count(*)::int as n from orders where coalesce(certification_pilot,false)=false and created_at >= $1",[new Date(at).toISOString()]);
    const n=Number(rows?.[0]?.n);
    return isCount(n)?n:null;
  }catch{return null;}
}
export function createFinancialProofSnapshot(env,classified,{now=Date.now(),checkoutsStarted=null}={}){
  const details=classified?.result||{};
  const sha=String(env?.ZEVANORY_RELEASE_SHA||"");
  const verified=classified?.code===200&&details.complete===true&&details.ambiguous===0&&/^[0-9a-f]{40}$/.test(sha)&&
    ["production_confirmed","production_paid_orders","production_payment_events","production_refund_events","certification_events"]
      .every(k=>isCount(details[k]))&&isCount(details.orders?.certification)&&isCount(details.orders?.noncertified_unverified)&&
    details.production_paid_orders<=details.production_payment_events&&
    details.production_payment_events+details.production_refund_events<=details.production_confirmed;
  return {
    schema:"zevanory.production-financial-proof/v1",
    release_sha:sha,
    measured_at:new Date(now).toISOString(),
    verified:Boolean(verified),
    ambiguous:cleanCount(details.ambiguous),
    production:verified?{
      paid_orders:details.production_paid_orders,
      payment_events:details.production_payment_events,
      refund_events:details.production_refund_events,
      checkouts_started:isCount(checkoutsStarted)?checkoutsStarted:null
    }:{paid_orders:0,payment_events:0,refund_events:0,checkouts_started:null},
    certification:verified?{events:details.certification_events,orders_flagged:details.orders.certification}:{events:null,orders_flagged:null},
    unverified:verified?{orders:details.orders.noncertified_unverified}:{orders:null},
    // Never copy payment IDs, external references or customer information to KV.
  };
}
export function verifyFinancialProofSnapshot(snapshot,env,{now=Date.now()}={}){
  if(!snapshot||snapshot.schema!=="zevanory.production-financial-proof/v1"||snapshot.verified!==true)return false;
  if(String(snapshot.release_sha||"")!==String(env?.ZEVANORY_RELEASE_SHA||"")||
    !/^[0-9a-f]{40}$/.test(String(snapshot.release_sha||"")))return false;
  const measured=Date.parse(String(snapshot.measured_at||""));
  if(!Number.isFinite(measured)||measured>now||now-measured>MAX_AGE_MS)return false;
  if(snapshot.ambiguous!==0)return false;
  return ["paid_orders","payment_events","refund_events"].every(k=>isCount(snapshot.production?.[k]))&&
    snapshot.production.paid_orders<=snapshot.production.payment_events&&
    (snapshot.production.checkouts_started==null||isCount(snapshot.production.checkouts_started))&&
    isCount(snapshot.certification?.events)&&isCount(snapshot.certification?.orders_flagged)&&
    isCount(snapshot.unverified?.orders);
}
export async function readFinancialProofSnapshot(env,{now=Date.now()}={}){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv?.get)return null;
  try{
    const raw=await kv.get(COMMERCIAL_PROOF_KV_KEY);
    const snap=JSON.parse(String(raw||"null"));
    return verifyFinancialProofSnapshot(snap,env,{now})?snap:null;
  }catch{return null;}
}
export async function refreshFinancialProofSnapshot(env,{sqlFactory,now=Date.now()}={}){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv?.get||!kv?.put||!sqlFactory||!env?.DATABASE_URL)return {ok:false,reason:"unavailable"};
  let prior=null;
  try{prior=JSON.parse(String(await kv.get(COMMERCIAL_PROOF_KV_KEY)||"null"));}catch{}
  const priorAt=Date.parse(String(prior?.measured_at||""));
  if(Number.isFinite(priorAt)&&priorAt<=now&&now-priorAt<MIN_REFRESH_MS&&prior?.release_sha===env.ZEVANORY_RELEASE_SHA)
    return {ok:verifyFinancialProofSnapshot(prior,env,{now}),reason:"recent_snapshot"};
  const audited=await collectFinancialProvenanceReadOnly(env,{sqlFactory});
  const checkoutsStarted=await countProductionCheckouts(env,{sqlFactory});
  const snapshot=createFinancialProofSnapshot(env,audited,{now,checkoutsStarted});
  await kv.put(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(snapshot),{expirationTtl:2*3600});
  return {ok:snapshot.verified,ambiguous:snapshot.ambiguous,reason:snapshot.verified?"proven":"unverified"};
}
export function projectProductionOnlyStatus(body={},proof=null,{now=Date.now(),env={},salesRelease=false}={}){
  const verified=verifyFinancialProofSnapshot(proof,env,{now});
  // Release is real only when the owner-authorized switch is live (salesRelease, computed by the
  // caller from the switch + production env) AND the production proof is fresh and exact.
  const releaseAllowed=verified&&salesRelease===true;
  const legacy=body.metrics||{};
  const metric=key=>cleanCount(legacy[key]);
  const production=verified?proof.production:{paid_orders:0,payment_events:0,refund_events:0};
  const metrics={
    ...legacy,
    orders:production.paid_orders,
    payments_confirmed:production.payment_events,
    refunds_confirmed:production.refund_events,
    checkouts_started:verified?cleanCount(proof.production.checkouts_started):0
  };
  const historical={
    orders:metric("orders"),
    payments_confirmed:metric("payments_confirmed"),
    refunds_confirmed:metric("refunds_confirmed"),
    checkouts_started:metric("checkouts_started")
  };
  const hadPaid=verified&&production.payment_events>0;
  const rawExp=body.experiment||{};
  return {
    ...body,
    gate:releaseAllowed?"G3":"G2",
    experiment:{...rawExp,status:releaseAllowed?(hadPaid?"commercial_live_payment_observed":"commercial_live_awaiting_first_payment"):
      (hadPaid?"production_payment_observed_commercial_locked":"technical_ready_commercial_not_started")},
    metrics,
    economics:null,
    commercial_metrics_provenance:{
      schema:"zevanory.commercial-only-projection/v1",
      state:verified?"PROVEN":"UNVERIFIED_FAIL_CLOSED",
      source:"provider_get_verified_snapshot",
      exact_release:verified,
      measured_at:verified?proof.measured_at:null,
      commercial_release_allowed:releaseAllowed,
      checkouts_measured:verified&&proof.production.checkouts_started!=null
    },
    test_certification:verified?{...proof.certification}:{events:null,orders_flagged:null},
    unverified_internal_orders:verified?proof.unverified.orders:null,
    legacy_technical_unverified_counts:historical,
    legacy_economics_suppressed:Boolean(body.economics)
  };
}

// Persist a snapshot from an already-computed, authenticated read-only classification
// (same validation as the scheduled refresh). Writes only the derived KV artifact.
export async function persistClassificationSnapshot(env,classified,{now=Date.now(),sqlFactory=null}={}){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv?.put)return {ok:false,reason:"kv_unavailable"};
  const snapshot=createFinancialProofSnapshot(env,classified,{now,checkoutsStarted:await countProductionCheckouts(env,{sqlFactory})});
  if(!snapshot.verified)return {ok:false,reason:"unverified_not_persisted"};
  await kv.put(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(snapshot),{expirationTtl:2*3600});
  return {ok:true,reason:"proven"};
}
// Diagnostic view of the stored snapshot: no counts beyond what /api/status shows, no IDs.
export async function describeFinancialProofSnapshot(env,{now=Date.now()}={}){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv?.get)return {present:false,reason:"kv_unavailable"};
  let snap=null;
  try{snap=JSON.parse(String(await kv.get(COMMERCIAL_PROOF_KV_KEY)||"null"));}catch{return {present:true,reason:"corrupt"};}
  if(!snap)return {present:false,reason:"absent"};
  const at=Date.parse(String(snap.measured_at||""));
  return {present:true,schema_ok:snap.schema==="zevanory.production-financial-proof/v1",verified_flag:snap.verified===true,
    release_matches:String(snap.release_sha||"")===String(env?.ZEVANORY_RELEASE_SHA||""),
    age_minutes:Number.isFinite(at)?Math.round((now-at)/60000):null,ambiguous:snap.ambiguous??null,
    accepted:verifyFinancialProofSnapshot(snap,env,{now})};
}
