import test from "node:test";
import assert from "node:assert/strict";
import {verifyChatTurnstile,CHAT_TURNSTILE_ACTION} from "../worker/r120-chat-turnstile.mjs";
const env={SITE_CHAT_TURNSTILE_SECRET:"fake-test-secret"};
const mock=(data,status=200)=>async()=>({ok:status===200,json:async()=>data});
test("R120 Turnstile missing secret/token fails closed without external request",async()=>{
 let called=0;const fx=async()=>{called++;throw Error("should not run")};
 assert.equal(await verifyChatTurnstile("",env,fx),false);
 assert.equal(await verifyChatTurnstile("valid",{ },fx),false);
 assert.equal(called,0);
});
test("R120 Turnstile requires verified action and owned hostname",async()=>{
 const good={success:true,action:CHAT_TURNSTILE_ACTION,hostname:"vendas.zevanory.api.br"};
 assert.equal(await verifyChatTurnstile("token",env,mock(good)),true);
 assert.equal(await verifyChatTurnstile("token",env,mock({...good,hostname:"evil.example"})),false);
 assert.equal(await verifyChatTurnstile("token",env,mock({...good,action:"login"})),false);
});
test("R120 Turnstile provider failure and replay rejection fail closed",async()=>{
 assert.equal(await verifyChatTurnstile("token",env,mock({success:false,"error-codes":["timeout-or-duplicate"]})),false);
 assert.equal(await verifyChatTurnstile("token",env,async()=>{throw Error("network down")}),false);
 assert.equal(await verifyChatTurnstile("token",env,mock({},503)),false);
});
test("R120 synthetic sandbox validation is local and requires explicit sandbox flag",async()=>{
 const fx=async()=>{throw Error("sandbox attempted network")};
 assert.equal(await verifyChatTurnstile(undefined,{SITE_CHAT_SANDBOX:"true"},fx),true);
 assert.equal(await verifyChatTurnstile(undefined,{},fx),false);
});
