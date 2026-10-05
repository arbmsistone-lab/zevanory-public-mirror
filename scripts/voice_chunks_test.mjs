import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {writeFileSync} from "node:fs";
import {handleVoiceChunk,voiceSignedHeaders,encodePcmInChunks,renderVoiceSecret,handleVoiceStream} from "../worker/voice-chunks.mjs";
globalThis.crypto ||= webcrypto;
const env={ELITE_INTERNAL_TOKEN:"unit-test-existing-secret-at-least-32-characters"};
const pcm=new Uint8Array(8000*2*5);
const view=new DataView(pcm.buffer);for(let i=0;i<pcm.length/2;i++)view.setInt16(i*2,Math.round(6000*Math.sin(2*Math.PI*440*i/8000)),true);
const encoded=await encodePcmInChunks(pcm,8000,env,req=>handleVoiceChunk(req,env),{auditId:"unit-seams"});
assert.equal(encoded.fallback_used,false);assert.equal(encoded.chunks.length,4);
writeFileSync("/tmp/chunk-quality.mp3",encoded.bytes);writeFileSync("/tmp/chunk-original.pcm",pcm);
assert.equal((await handleVoiceChunk(new Request("https://internal/internal/voice/encode-chunk",{method:"POST",body:new Uint8Array(8)}),env)).status,401);
const block=new Uint8Array((1152+11520+1152)*2),meta={samples:11520,first:true,last:true,index:0};
const headers=await voiceSignedHeaders(block,8000,env,meta);
const request=new Request("https://internal/internal/voice/encode-chunk",{method:"POST",headers,body:block});
assert.equal((await handleVoiceChunk(request.clone(),env)).status,200);
assert.equal((await handleVoiceChunk(request.clone(),env)).status,401);
const bad=request.clone();const bytes=new Uint8Array(await bad.arrayBuffer());bytes[1]=2;
assert.equal((await handleVoiceChunk(new Request(request,{body:bytes}),env)).status,401);
let attempts=0,fallback=0;
const recovered=await encodePcmInChunks(pcm,8000,env,async(req,init)=>{
 if(req instanceof Request){attempts++;return attempts<3?new Response("",{status:503}):handleVoiceChunk(req,env);}
 fallback++;throw Error("unexpected reserve");
});
assert.equal(recovered.fallback_used,false);assert.equal(recovered.chunks[0].http,503);assert.equal(recovered.chunks[2].http,200);assert.equal(fallback,0);
attempts=0;
const reserve=await encodePcmInChunks(pcm,8000,env,async(req,init)=>{
 if(req instanceof Request){attempts++;return new Response("",{status:503});}
 fallback++;assert.equal(String(req),"https://zevanory-product-control-edge.onrender.com/api/voice/encode");assert.ok(init.signal);return new Response(encoded.bytes);
});
assert.equal(attempts,3);assert.equal(fallback,1);assert.equal(reserve.fallback_used,true);
console.log("CHUNK_HMAC_REPLAY_TAMPER_ORDER_RETRY_RESERVE=PASS");

const killedEnv={...env,SELF:{fetch:async()=>{throw Error("Worker exceeded CPU time limit.");}}};
let protectedReserve=0;
const protectedResult=await encodePcmInChunks(pcm,8000,killedEnv,async(url,init)=>{
 protectedReserve++;assert.match(String(url),/zevanory-product-control-edge/);return new Response(encoded.bytes);
});
assert.equal(protectedReserve,1);assert.equal(protectedResult.provider,"render");
assert.match(protectedResult.chunk_error,/exceeded CPU/);
const streamUnauth=await handleVoiceStream(new Request("https://internal/api/internal/voice/encode-stream",{method:"POST",body:pcm}),env);
assert.equal(streamUnauth.status,401);
let coordinatorCalls=0;
const isolated=await encodePcmInChunks(pcm,8000,{...env,SELF:{fetch:async(req)=>{
 coordinatorCalls++;assert.match(req.url,/encode-stream/);
 return new Response(encoded.bytes,{headers:{"x-voice-provider":"cloudflare-chunks","x-voice-chunks":"[]","x-voice-fallback-used":"false"}});
}}});
assert.equal(coordinatorCalls,1);assert.equal(isolated.fallback_used,false);
console.log("COORDINATOR_CPU_FAILURE_RESERVE_PROTECTED=PASS");

globalThis.__ZEVANORY_VOICE_SELF__={fetch:async(req)=>{
 assert.match(req.url,/encode-stream/);
 return new Response(encoded.bytes,{headers:{"x-voice-provider":"cloudflare-chunks","x-voice-chunks":"[]","x-voice-fallback-used":"false"}});
}};
const bridged=await encodePcmInChunks(pcm,8000,env,async()=>{throw Error("bridge lost SELF");});
assert.equal(bridged.provider,"cloudflare-chunks");
delete globalThis.__ZEVANORY_VOICE_SELF__;
console.log("NODE_WEBHOOK_BRIDGE_SELF_PRESERVED=PASS");
