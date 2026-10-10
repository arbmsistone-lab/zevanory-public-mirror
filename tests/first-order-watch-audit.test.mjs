import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {handleFirstOrderWatchReadOnly,FIRST_ORDER_WATCH_SQL} from "../worker/first-order-watch-audit.mjs";
const SECRET="a".repeat(40),PATH="/api/internal/watch/paid-delivery";
const values={checkouts:2,paid:0,delivered:0,overdue_paid:0,fulfillment_failed:0};
function signed({key=SECRET,at=Math.floor(Date.now()/1000),method="GET",headers=true}={}){
 const sig=createHmac("sha256",key).update("GET\n"+PATH+"\n"+at).digest("hex");
 return new Request("https://zevanory.api.br"+PATH,{method,headers:headers?{
  "x-zevanory-audit-ts":String(at),"x-zevanory-audit-signature":sig}:{}});
}
function database(rows=[values]){
 return ()=>({query:async(text,params)=>{
  assert.match(text,/certification_pilot IS FALSE/);assert.match(text,/provider_status IN/);
  assert.deepEqual(params,["2026-10-09T20:19:12Z"]);return rows;
 }});
}
test("signed GET returns aggregate-only, never PII",async()=>{
 const res=await handleFirstOrderWatchReadOnly(signed(),{CERTIFICATION_E2E_TOKEN:SECRET,DATABASE_URL:"mock"},{sqlFactory:database()});
 assert.equal(res.status,200);assert.deepEqual(await res.json(),{schema:"zevanory.first-order-watch.v1",counts:values});
});
test("unsigned, forged, stale and wrong method rejected before SQL",async()=>{
 for(const request of [signed({headers:false}),signed({key:"b".repeat(40)}),
   signed({at:Math.floor(Date.now()/1000)-400}),signed({method:"POST"})]){
  const res=await handleFirstOrderWatchReadOnly(request,{CERTIFICATION_E2E_TOKEN:SECRET,DATABASE_URL:"mock"},{
   sqlFactory:()=>{throw Error("sql should not run")}});
  assert.notEqual(res.status,200);
 }
});
test("DB failure and inconsistent counts fail closed and suppress private error",async()=>{
 const env={CERTIFICATION_E2E_TOKEN:SECRET,DATABASE_URL:"mock"};
 const response=await handleFirstOrderWatchReadOnly(signed(),env,{sqlFactory:()=>({query:async()=>{throw Error("secret@invalid.com")}})});
 assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret@/);
 const bad=await handleFirstOrderWatchReadOnly(signed(),env,{sqlFactory:database([{...values,overdue_paid:1}])});
 assert.equal(bad.status,503);
});
test("SQL selects only aggregates, no writes or customer fields",()=>{
 assert.match(FIRST_ORDER_WATCH_SQL,/interval '15 minutes'/);
 assert.doesNotMatch(FIRST_ORDER_WATCH_SQL,/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
 assert.doesNotMatch(FIRST_ORDER_WATCH_SQL,/\b(email|phone|payer|buyer|external_reference|provider_payment_id)\b/i);
});
