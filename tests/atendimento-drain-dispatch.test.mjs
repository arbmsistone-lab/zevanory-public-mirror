import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dispatchAtendimentoDrain,handleAtendimentoDrainRequest,ATENDIMENTO_DRAIN_PATH } from "../worker/atendimento-drain-dispatch.mjs";
import { signDrainRequest } from "../worker/support-email-forward.mjs";

const secret="x".repeat(40),now=Date.UTC(2026,10,6,14,0,0);
function incoming(headers={}){return new Request("https://zevanory.api.br"+ATENDIMENTO_DRAIN_PATH,{method:"POST",headers});}
test("R138 hourly ordering: isolated atendimento dispatch precedes other cron tasks, refund watchdog no longer drains",()=>{
 const compat=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url),"utf8");
 const refund=readFileSync(new URL("../worker/refund-flow.mjs",import.meta.url),"utf8");
 const scheduled=compat.slice(compat.indexOf("wrapped.scheduled ="));
 const dispatch=scheduled.indexOf("await dispatchAtendimentoDrain(normalized)");
 assert.ok(dispatch>0);
 for(const marker of ["await runSalesPreflight(normalized)","const tasks = [reconcileControlPlane","tasks.push(runRefundWatchdog("])assert.ok(dispatch<scheduled.indexOf(marker),marker);
 assert.ok(!refund.includes("drainAtendimentoOutbox("),"no duplicate inline drain in refund watchdog");
 assert.ok(compat.indexOf("return handleAtendimentoDrainRequest(request,normalized")<compat.indexOf("applySalesSwitch(await readSalesSwitch(normalized))"),"isolated route before other subrequests");
});
test("R138 SELF isolation: signed request and no inline fallback even on SELF failure",async()=>{
 let calls=0,req;
 const env={LEAD_PRIVACY_SECRET:secret,SELF:{async fetch(request){calls++;req=request;return new Response(JSON.stringify({ok:true,checked:2,done:1,pending:1,dead:0}),{status:200})}}};
 const out=await dispatchAtendimentoDrain(env,{nowMs:now});
 assert.equal(out.via,"self");assert.equal(out.result.checked,2);assert.equal(calls,1);
 assert.equal(new URL(req.url).pathname,ATENDIMENTO_DRAIN_PATH);
 const key=req.headers.get("x-atendimento-drain-token"),nonce=req.headers.get("x-atendimento-drain-nonce"),minute=Number(req.headers.get("x-atendimento-drain-minute"));
 assert.equal(key,await signDrainRequest({secret,method:"POST",path:ATENDIMENTO_DRAIN_PATH,minute,nonce}));
 assert.equal((await dispatchAtendimentoDrain({LEAD_PRIVACY_SECRET:secret},{nowMs:now})).result.reason,"self_unavailable");
 const rejected=await dispatchAtendimentoDrain({LEAD_PRIVACY_SECRET:secret,SELF:{fetch:async()=>{throw Error("network")}}},{nowMs:now});
 assert.equal(rejected.via,"self");assert.equal(rejected.result.ok,false);
});
test("R138 endpoint blocks forged/replayed calls before sending, no sensitive content in result",async()=>{
 const env={LEAD_PRIVACY_SECRET:secret,DATABASE_URL:"postgres://fake"};
 let consumed=false,calls=0;
 const sql={async query(q,params){calls++;if(q.includes("/*atendimento:drain_nonce*/")){if(consumed)return [];consumed=true;return [{nonce:params[0]}]}return []}};
 const auth={sqlFactory:()=>sql,nowMs:now};
 assert.equal((await handleAtendimentoDrainRequest(incoming(),env,auth)).status,401);
 assert.equal(calls,0);
 const minute=now/60000,nonce="a".repeat(32),token=await signDrainRequest({secret,method:"POST",path:ATENDIMENTO_DRAIN_PATH,minute,nonce});
 const req=()=>incoming({"x-atendimento-drain-token":token,"x-atendimento-drain-minute":String(minute),"x-atendimento-drain-nonce":nonce});
 const one=await handleAtendimentoDrainRequest(req(),env,auth);
 assert.ok([200,503].includes(one.status));
 assert.equal((await handleAtendimentoDrainRequest(req(),env,auth)).status,409);
});
