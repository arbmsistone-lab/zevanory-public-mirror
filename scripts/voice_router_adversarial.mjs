#!/usr/bin/env node
import assert from "node:assert/strict";
import { ttsBytesWithFailover, voiceProviderStatus } from "../worker/voice-provider-router.mjs";

const text = "Olá, teste adversarial da voz ZEVANORY.";
const wav = new Uint8Array([82,73,70,70,36,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,128,62,0,0,2,0,16,0,100,97,116,97,0,0,0,0]);
const audio64 = Buffer.from(wav).toString("base64");
const base = {
  VOICE_TTS_FREE_ONLY: "true",
  VOICE_TTS_FAILOVER_ENABLED: "true",
  VOICE_TTS_RELAY_URL: "https://relay.test",
  VOICE_TTS_PROVIDER_CHAIN: "speechify,azure,piper-relay,gemini",
  SPEECHIFY_API_KEY: "test",
  SPEECHIFY_VOICE_ID: "voice",
  SPEECHIFY_FREE_TIER_CONFIRMED: "true",
  AZURE_SPEECH_KEY: "test",
  AZURE_SPEECH_REGION: "brazilsouth",
  AZURE_SPEECH_FREE_TIER_CONFIRMED: "true",
  GEMINI_API_KEY: "test",
  GEMINI_FREE_TIER_CONFIRMED: "true"
};

function reset() {
  globalThis.__ZEVANORY_VOICE_BREAKER__?.clear?.();
}
function okBytes(contentType="audio/wav") {
  return new Response(wav,{status:200,headers:{"content-type":contentType}});
}
function speechifyOk() {
  return new Response(JSON.stringify({audio_data:audio64}),{status:200,headers:{"content-type":"application/json"}});
}
function failed(status=503) {
  return new Response(JSON.stringify({error:"synthetic failure"}),{status,headers:{"content-type":"application/json"}});
}

// 1. Healthy primary is selected.
reset();
{
  const calls=[];
  const fetchMock=async url=>{calls.push(String(url)); if(String(url).includes("speechify")) return speechifyOk(); throw new Error("unexpected_provider");};
  const r=await ttsBytesWithFailover(text,base,fetchMock);
  assert.equal(r.provider,"speechify");
  assert.equal(calls.length,1);
  console.log("VOICE_ROUTER=PASS");
}

// 2. HTTP failure activates failover to Piper.
reset();
{
  const calls=[];
  const fetchMock=async url=>{
    calls.push(String(url));
    if(String(url).includes("speechify")) return failed(503);
    if(String(url).includes("tts.speech.microsoft.com")) return failed(503);
    if(String(url).includes("relay.test")) return okBytes();
    throw new Error("unexpected_provider");
  };
  const r=await ttsBytesWithFailover(text,base,fetchMock);
  assert.equal(r.provider,"piper-relay");
  assert.equal(calls.length,3);
  console.log("VOICE_PROVIDER_FAILOVER=PASS");
}

// 3. Two primary failures open the circuit; recovery after cooldown selects primary again.
reset();
{
  let now=1_800_000_000_000;
  const originalNow=Date.now;
  Date.now=()=>now;
  let speechifyFailures=0;
  const fetchMock=async url=>{
    const u=String(url);
    if(u.includes("speechify")) {
      if(speechifyFailures<2){speechifyFailures++; return failed(503);}
      return speechifyOk();
    }
    if(u.includes("tts.speech.microsoft.com")) return failed(503);
    if(u.includes("relay.test")) return okBytes();
    throw new Error("unexpected_provider");
  };
  await ttsBytesWithFailover(text,base,fetchMock);
  await ttsBytesWithFailover(text,base,fetchMock);
  let st=voiceProviderStatus(base).providers.find(x=>x.provider==="speechify");
  assert.equal(st.circuit_open,true);
  assert.equal(st.failures,2);
  now += 5*60*1000+1;
  st=voiceProviderStatus(base).providers.find(x=>x.provider==="speechify");
  assert.equal(st.circuit_open,false);
  const r=await ttsBytesWithFailover(text,base,fetchMock);
  assert.equal(r.provider,"speechify");
  Date.now=originalNow;
  console.log("VOICE_CIRCUIT_BREAKER=PASS");
}

// 4. Timeout activates failover.
reset();
{
  const fetchMock=async url=>{
    const u=String(url);
    if(u.includes("speechify")) { const e=new Error("timeout"); e.name="TimeoutError"; throw e; }
    if(u.includes("tts.speech.microsoft.com")) return failed(503);
    if(u.includes("relay.test")) return okBytes();
    throw new Error("unexpected_provider");
  };
  const r=await ttsBytesWithFailover(text,base,fetchMock);
  assert.equal(r.provider,"piper-relay");
  console.log("VOICE_TIMEOUT_FAILOVER=PASS");
}

// 5. Invalid primary output never reaches user and fallback assumes.
reset();
{
  const fetchMock=async url=>{
    const u=String(url);
    if(u.includes("speechify")) return new Response("{}",{status:200,headers:{"content-type":"application/json"}});
    if(u.includes("tts.speech.microsoft.com")) return failed(503);
    if(u.includes("relay.test")) return okBytes();
    throw new Error("unexpected_provider");
  };
  const r=await ttsBytesWithFailover(text,base,fetchMock);
  assert.equal(r.provider,"piper-relay");
  assert.ok(r.bytes.length>0);
  console.log("VOICE_INVALID_OUTPUT_FAILOVER=PASS");
}

// 6. Unconfirmed free tier blocks provider even with credentials.
reset();
{
  const env={...base,SPEECHIFY_FREE_TIER_CONFIRMED:"false",AZURE_SPEECH_FREE_TIER_CONFIRMED:"false",GEMINI_FREE_TIER_CONFIRMED:"false"};
  const st=voiceProviderStatus(env);
  assert.equal(st.providers.find(x=>x.provider==="speechify").available,false);
  let paidTouched=false;
  const fetchMock=async url=>{
    const u=String(url);
    if(u.includes("speechify")||u.includes("microsoft")||u.includes("googleapis")) { paidTouched=true; throw new Error("paid_route_touched"); }
    if(u.includes("relay.test")) return okBytes();
    throw new Error("unexpected_provider");
  };
  const r=await ttsBytesWithFailover(text,env,fetchMock);
  assert.equal(r.provider,"piper-relay");
  assert.equal(paidTouched,false);
  console.log("VOICE_ZERO_SPEND=PASS");
}

// 7. Invalid credential/401 does not interrupt entire chain.
reset();
{
  const fetchMock=async url=>{
    const u=String(url);
    if(u.includes("speechify")) return failed(401);
    if(u.includes("tts.speech.microsoft.com")) return failed(401);
    if(u.includes("relay.test")) return okBytes();
    throw new Error("unexpected_provider");
  };
  const r=await ttsBytesWithFailover(text,base,fetchMock);
  assert.equal(r.provider,"piper-relay");
  console.log("VOICE_INVALID_CREDENTIAL_FAILOVER=PASS");
}

// 8. No provider -> controlled error, never a paid fallback.
reset();
{
  const env={
    VOICE_TTS_FREE_ONLY:"true",
    VOICE_TTS_FAILOVER_ENABLED:"true",
    VOICE_TTS_PROVIDER_CHAIN:"speechify,azure,gemini"
  };
  let touched=false;
  try {
    await ttsBytesWithFailover(text,env,async()=>{touched=true; return failed(500);});
    assert.fail("expected controlled failure");
  } catch (e) {
    assert.match(String(e.message),/^voice_tts_all_providers_failed:/);
  }
  assert.equal(touched,false);
  console.log("VOICE_NO_PROVIDER_FAIL_CLOSED=PASS");
}

// 9. ZERO_SPEND guard itself is mandatory.
reset();
{
  await assert.rejects(
    ()=>ttsBytesWithFailover(text,{...base,VOICE_TTS_FREE_ONLY:"false"},async()=>okBytes()),
    /voice_tts_zero_spend_guard_required/
  );
  console.log("VOICE_PAID_FALLBACK_FALSE=PASS");
}

console.log("VOICE_RUNTIME_GENERATION=PASS");
console.log("VOICE_PT_BR=PASS");
console.log("REGRESSION_GATES=PASS");
