import test from "node:test";
import assert from "node:assert/strict";
import { emitActivity, ACTIVITY_EVENT_PREFIX, ACTIVITY_REF_PREFIX, ACTIVITY_TTL_SECONDS, ACTIVITY_TYPES } from "../worker/activity-ledger.mjs";

const types=[
 "checkout_created","payment_confirmed","delivery_sent","download_done",
 "refund_requested","refund_approved","refund_ambiguous","post_published",
 "whatsapp_replied","link_sent","lead_captured","email_sent",
 "owner_alert_sent","sales_switch","deploy","certification","review_received"
];
const fixed=Date.parse("2026-10-09T21:00:00Z");
const store=()=>{const m=new Map();return {m,kv:{
 get:async key=>m.get(key)||null,
 put:async (key,val,opt)=>{assert.equal(opt.expirationTtl,90*86400);m.set(key,val)}
}}};
test("one activity per all 17 supported types without PII or raw refs",async()=>{
 assert.equal(types.length,17);
 assert.equal(ACTIVITY_TYPES.size,17);
 for(const type of types){
   const {m,kv}=store();
   const finance=type==="payment_confirmed"||type==="refund_approved";
   const env={ZEVANORY_PRIVATE_ARTIFACTS:kv};
   const opts={type,channel:finance?"finance":"web",status:"recorded",ref:"order-private-123@example.com",
     financialProof:finance?"provider-get-verified":undefined,
     amount:finance?3700:undefined};
   const first=await emitActivity(env,opts,{now:fixed});
   assert.equal(first.emitted,true,type);
   assert.ok(first.key.startsWith(ACTIVITY_EVENT_PREFIX));
   assert.ok([...m.keys()].some(k=>k.startsWith(ACTIVITY_REF_PREFIX)));
   const serialized=m.get(first.key);
   assert.ok(serialized.includes('"schema":"zevanory.activity.v1"'));
   for(const sensitive of ["order-private","@example.com","payer","payment_id","token"]) {
     assert.ok(!serialized.includes(sensitive),type+" contains "+sensitive);
   }
   assert.equal((await emitActivity(env,opts,{now:fixed+5})).duplicate,true,type);
   assert.equal([...m.keys()].filter(k=>k.startsWith(ACTIVITY_EVENT_PREFIX)).length,1);
 }
});
test("finance rejected without provider-GET proof; malformed or unsafe inputs rejected",async()=>{
 const {m,kv}=store(),env={ZEVANORY_PRIVATE_ARTIFACTS:kv};
 assert.equal((await emitActivity(env,{type:"payment_confirmed",channel:"finance",status:"confirmed",ref:"order-1",amount:3700},{now:fixed})).reason,"financial_proof_required");
 for(const arg of [
 {type:"payment_confirmed",channel:"finance",status:"confirmed",ref:"order-1",financialProof:"provider-get-verified",amount:-3},
 {type:"payment_confirmed",channel:"finance",status:"confirmed",ref:"order-1",financialProof:"provider-get-verified",amount:1.25},
 {type:"checkout_created",channel:"web",status:"recorded",ref:"",link:null},
 {type:"checkout_created",channel:"web",status:"recorded",ref:"order-1",link:"https://bad.invalid/?email=a"},
 {type:"checkout_created",channel:"web",status:"recorded",ref:"order-1",link:"http://zevanory.api.br"},
 {type:"totally_fake",channel:"web",status:"recorded",ref:"order-1"}
 ]) assert.equal((await emitActivity(env,arg,{now:fixed})).emitted,false);
 assert.equal(m.size,0);
});
test("safe public UTM link retained; unsafe query stripped",async()=>{
 const {m,kv}=store();
 const out=await emitActivity({ZEVANORY_PRIVATE_ARTIFACTS:kv},{
  type:"post_published",channel:"telegram",status:"published",ref:"telegram:123",
  link:"https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=telegram&email=private%40example.com"
 },{now:fixed});
 assert.equal(out.emitted,true);
 const event=JSON.parse(m.get(out.key));
 assert.equal(event.link,"https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=telegram");
});
test("missing or failing shared KV fails closed without exposing references",async()=>{
 assert.equal((await emitActivity({}, {type:"deploy",channel:"system",status:"pass",ref:"a"})).reason,"kv_unavailable");
 const bad={get:async()=>null,put:async()=>{throw Error("sensitive@example.com")}};
 const result=await emitActivity({ZEVANORY_PRIVATE_ARTIFACTS:bad},{type:"deploy",channel:"system",status:"pass",ref:"a"});
 assert.deepEqual(result,{emitted:false,reason:"kv_write_failed"});
 assert.equal(ACTIVITY_TTL_SECONDS,90*86400);
});
