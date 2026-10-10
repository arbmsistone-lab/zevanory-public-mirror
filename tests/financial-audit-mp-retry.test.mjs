import test from "node:test";
import assert from "node:assert/strict";
import {mpGet, classifyPaymentEvidence} from "../worker/internal-financial-audit.mjs";
const pilot={id:"1232795",orphan:false,pilot:true};
const response=(status)=>({status,json:async()=>({id:"1232795"})});
function setup(sequence,budget={remaining:46,retries:6}){
  const seen=[],delays=[];
  const fetchImpl=async()=>{const status=sequence[seen.length];seen.push(status);if(status===0)throw Error("network");return response(status)};
  const sleep=async ms=>{delays.push(ms)};
  return {budget,seen,delays,opts:{fetchImpl,sleep}};
}
test("network error then 404 proves pilot only with provider 404",async()=>{
 const x=setup([0,404]);const r=await mpGet("/v1/payments/1232795","APP_PROD",x.budget,x.opts);
 assert.equal(r.status,404);assert.equal(classifyPaymentEvidence(pilot,r,"999").classification,"teste_certificacao");
 assert.deepEqual(x.delays,[500]);assert.deepEqual(x.seen,[0,404]);
});
test("429 twice then 404; bounded 500 and 1500 ms delays",async()=>{
 const x=setup([429,429,404]);const r=await mpGet("/v1/payments/1232795","APP_PROD",x.budget,x.opts);
 assert.equal(r.status,404);assert.deepEqual(x.seen,[429,429,404]);assert.deepEqual(x.delays,[500,1500]);
});
test("404 and 200 and 401 and 403 do not retry",async()=>{
 for(const status of [404,200,401,403]){const x=setup([status,429]);const r=await mpGet("/v1/payments/1232795","APP_PROD",x.budget,x.opts);
 assert.equal(r.status,status);assert.equal(x.seen.length,1);}
});
test("exhausted shared budget remains ambiguous; never fabricates 404",async()=>{
 const x=setup([429,404],{remaining:1,retries:6});const r=await mpGet("/v1/payments/1232795","APP_PROD",x.budget,x.opts);
 assert.equal(r.status,429);assert.equal(x.seen.length,1);
 assert.equal(classifyPaymentEvidence(pilot,r,"999").classification,"ambiguo");
});
test("six retries max across shared calls",async()=>{
 const x=setup([503,503,503],{remaining:46,retries:1});const r=await mpGet("/v1/payments/1232795","APP_PROD",x.budget,x.opts);
 assert.equal(r.status,503);assert.equal(x.seen.length,2);assert.equal(x.budget.retries,0);
});
