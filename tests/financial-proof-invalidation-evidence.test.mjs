import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createFinancialProofSnapshot,readFinancialProofSnapshot,refreshFinancialProofSnapshot,COMMERCIAL_PROOF_KV_KEY,PROOF_INVALIDATION_KV_KEY} from "../worker/commercial-metrics-projection.mjs";
import {collectFinancialProvenanceReadOnly} from "../worker/internal-financial-audit.mjs";

const SHA="a".repeat(40), env={ZEVANORY_RELEASE_SHA:SHA}, now=Date.parse("2026-10-14T11:45:00Z");
const audited={code:200,result:{complete:true,ambiguous:0,production_confirmed:0,production_paid_orders:0,production_payment_events:0,production_refund_events:0,certification_events:3,orders:{certification:3,noncertified_unverified:19},payment_ids:{ambiguo:[]}}};
function seeded(){const m=new Map(),kv={get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);}};const e={...env,DATABASE_URL:"postgres://t",ZEVANORY_PRIVATE_ARTIFACTS:kv};m.set(COMMERCIAL_PROOF_KV_KEY,JSON.stringify(createFinancialProofSnapshot(e,audited,{now})));return {m,e};}
const run=(e,res,at)=>refreshFinancialProofSnapshot(e,{now:at,sqlFactory:()=>{},force:true,audit:async()=>res,countCheckouts:async()=>0});

test("behaviour unchanged: any 409 (transient-only or positive) still invalidates at once",async()=>{
  for(const r of [{ambiguous:2,ambiguous_transient:2},{ambiguous:1,ambiguous_transient:0},{ambiguous:3,ambiguous_transient:1}]){
    const {e}=seeded();
    const out=await run(e,{code:409,result:{...audited.result,...r}},now+30*60000);
    assert.equal(out.ok,false); assert.equal(out.reason,"ambiguous",JSON.stringify(r));
    assert.equal(await readFinancialProofSnapshot(e,{now:now+30*60000}),null,JSON.stringify(r));
  }
});
test("invalidation of a valid proof records when and a fixed diagnostic category",async()=>{
  let {m,e}=seeded();
  await run(e,{code:409,result:{...audited.result,ambiguous:2,ambiguous_transient:2}},now+30*60000);
  assert.deepEqual(JSON.parse(m.get(PROOF_INVALIDATION_KV_KEY)),{at:new Date(now+30*60000).toISOString(),reason:"ambiguous_transient"});
  ({m,e}=seeded());
  await run(e,{code:409,result:{...audited.result,ambiguous:1,ambiguous_transient:0}},now+30*60000);
  assert.equal(JSON.parse(m.get(PROOF_INVALIDATION_KV_KEY)).reason,"ambiguous");
  assert.doesNotMatch(m.get(PROOF_INVALIDATION_KV_KEY),/\d{6,}|payment|ids?"/,"no ids or counts");
});
test("503 keeps valid proof and records nothing; expiry stays at 65 minutes",async()=>{
  const {m,e}=seeded();
  await run(e,{code:503,result:{error:"x"}},now+30*60000);
  assert.ok(await readFinancialProofSnapshot(e,{now:now+30*60000}));
  assert.equal(m.has(PROOF_INVALIDATION_KV_KEY),false);
  assert.equal(await readFinancialProofSnapshot(e,{now:now+66*60000}),null);
});
test("public status exposes only {at, reason} from an allowlist",()=>{
  const src=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url),"utf8");
  assert.match(src,/last_invalidation: \{ at: inv\.at, reason: inv\.reason \}/);
  assert.match(src,/PROOF_INVALIDATION_REASONS\.includes\(inv\.reason\)/);
});
function auditWith(lookups){
  const rows=lookups.map(([id,pilot])=>({id,provider:"mercadopago",reference:"ZEVANORY:o"+id,order_id:"o"+id,normalized_event:"payment_confirmed",provider_event_id:"mp:"+id,pilot,orphan:false}));
  const sqlFactory=()=>({query:async t=>t.includes("count(*)")?[{total:rows.length,certification:rows.filter(r=>r.pilot).length}]:rows});
  const statuses=new Map(lookups.map(([id,,st])=>[id,st]));
  const orig=globalThis.fetch;
  globalThis.fetch=async u=>{const url=String(u);
    if(url.endsWith("/users/me"))return new Response(JSON.stringify({id:9876,site_id:"MLB",tags:["normal"]}),{status:200});
    const st=statuses.get(url.split("/").pop());
    if(st===0)throw new Error("network");
    return new Response(st===200?JSON.stringify({id:Number(url.split("/").pop()),collector_id:1,external_reference:"x",live_mode:true}):"{}",{status:st});};
  return collectFinancialProvenanceReadOnly({DATABASE_URL:"postgres://t",MERCADOPAGO_ACCESS_TOKEN:"APP_USR-x"},{sqlFactory}).finally(()=>{globalThis.fetch=orig;});
}
test("audit diagnostic: only network/429/5xx lookups count as transient; 409 code unchanged",{timeout:30000},async()=>{
  let r=await auditWith([["111",true,503],["222",true,404]]);
  assert.equal(r.code,409); assert.equal(r.result.ambiguous,1); assert.equal(r.result.ambiguous_transient,1);
  r=await auditWith([["111",true,0]]); assert.equal(r.code,409); assert.equal(r.result.ambiguous_transient,1);
  r=await auditWith([["111",true,403]]); assert.equal(r.result.ambiguous_transient,0,"403 is not transient");
  r=await auditWith([["111",false,200]]); assert.equal(r.result.ambiguous_transient,0,"collector mismatch is positive");
  r=await auditWith([["111",true,200]]); assert.equal(r.result.ambiguous_transient,0,"pilot visible is positive");
});
