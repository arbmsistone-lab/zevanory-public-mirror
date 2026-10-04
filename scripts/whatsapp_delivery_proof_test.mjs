import assert from "node:assert/strict";
import { webcrypto, createHmac } from "node:crypto";
import {handleWhatsappOnboarding} from "../worker/whatsapp-onboarding.mjs";
globalThis.crypto ||= webcrypto;
const master="synthetic-master-key-at-least-32-characters",operator="synthetic-operator-at-least-32-characters";
const record={app_id:"1071149631917061",app_secret:"synthetic-meta-secret",access_token:"synthetic-meta-access",phone_number_id:"1300972319774588",waba_id:"4019600665012911",verify_token:"synthetic-verify"};
const e=new TextEncoder(),iv=crypto.getRandomValues(new Uint8Array(12));
const key=await crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",e.encode("zevanory:whatsapp:onboarding:v1:"+master)),{name:"AES-GCM"},false,["encrypt"]);
const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,e.encode(JSON.stringify(record)));
const sealed=Buffer.from(iv).toString("base64url")+"."+Buffer.from(cipher).toString("base64url");
const env={ELITE_INTERNAL_TOKEN:master,OPERATOR_TOKEN:operator,ZEVANORY_PRIVATE_ARTIFACTS:{get:async()=>sealed}};
const request=(body,auth=true)=>new Request("https://zevanory.api.br/api/admin/whatsapp-onboard/delivery-proof",{method:"POST",headers:auth?{authorization:"Bearer "+operator}:{},body:JSON.stringify(body)});
let calls=0;
globalThis.fetch=async(url,init={})=>{
  calls++;
  if(String(url).endsWith("/subscriptions"))return Response.json({data:[{object:"whatsapp_business_account",callback_url:"https://zevanory.api.br/api/webhooks/meta",active:true,fields:[{name:"messages"}]}]});
  if(String(url).endsWith("/subscribed_apps"))return Response.json({data:[{whatsapp_business_api_data:{id:"1071149631917061"}}]});
  if(String(url).endsWith("/media")){assert.ok(init.body instanceof FormData);assert.ok(!init.headers["content-type"]);return Response.json({id:"synthetic-media"});}
  assert.equal(String(url),"https://zevanory.api.br/api/webhooks/meta");
  assert.equal(init.headers["x-hub-signature-256"],"sha256="+createHmac("sha256",record.app_secret).update(init.body).digest("hex"));
  const msg=JSON.parse(init.body).entry[0].changes[0].value.messages[0];
  assert.equal(msg.from,"558892545413");assert.match(msg.id,/^internal-(text|audio)-/);
  if(msg.type==="text")assert.equal(msg.text.body,"teste interno: quanto custa o combo?");
  else assert.equal(msg.audio.id,"synthetic-media");
  return Response.json({accepted:true});
};
assert.equal((await handleWhatsappOnboarding(request({operation:"text"},false),env)).status,401);assert.equal(calls,0);
assert.equal((await handleWhatsappOnboarding(request({operation:"arbitrary-send"}),env)).status,400);assert.equal(calls,0);
const subscriptions=await handleWhatsappOnboarding(request({operation:"subscriptions"}),env);assert.equal((await subscriptions.json()).valid,true);
const text=await handleWhatsappOnboarding(request({operation:"text",recipient:"ignored-attacker-target"}),env);
const proof=await text.json();assert.equal(proof.signature,"sha256="+createHmac("sha256",record.app_secret).update(proof.signed_body).digest("hex"));assert.equal(JSON.parse(proof.signed_body).entry[0].changes[0].value.messages[0].from,"558892545413");assert.ok(proof.body_sha256);assert.ok(!JSON.stringify(proof).includes(record.app_secret));
const audio=await handleWhatsappOnboarding(request({operation:"audio",audio_base64:Buffer.from("OggSsynthetic-unit-test").toString("base64")}),env);
const audioProof=await audio.json();assert.equal(JSON.parse(audioProof.signed_body).entry[0].changes[0].value.messages[0].audio.id,"synthetic-media");
console.log("DELIVERY_PROOF_AUTH_FIXED_RECIPIENT_HMAC_MEDIA_NO_SECRET_LEAK=PASS");

const {ttsBytesWithFailover}=await import("../worker/voice-provider-router.mjs");
const attempted=[];
await assert.rejects(()=>ttsBytesWithFailover("Olá",{VOICE_TTS_FREE_ONLY:"true",GEMINI_API_KEY:"synthetic",GEMINI_FREE_TIER_CONFIRMED:"true",VOICE_TTS_PROVIDER_CHAIN:"gemini",GEMINI_TTS_MODEL:"gemini-2.5-legacy"},async(url,init)=>{const b=JSON.parse(init.body);attempted.push(b.model);assert.ok(init.signal instanceof AbortSignal);return Response.json({error:{code:404}},{status:404});}),/voice_tts_all_providers_failed/);
assert.deepEqual(attempted,["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]);
console.log("GEMINI_TWO_CURRENT_MODELS_FAILOVER_NO_LEGACY=PASS");

const certification="synthetic-certification-at-least-32-characters";
const certEnv={...env,CERTIFICATION_E2E_TOKEN:certification};
const certRequest=new Request("https://zevanory.api.br/api/admin/whatsapp-onboard/delivery-proof",{method:"POST",headers:{authorization:"Bearer "+certification},body:JSON.stringify({operation:"subscriptions"})});
assert.equal((await handleWhatsappOnboarding(certRequest,certEnv)).status,200);
assert.equal((await handleWhatsappOnboarding(request({operation:"subscriptions"}),certEnv)).status,401);
console.log("DEDICATED_CERTIFICATION_AUTHORITY_PRECEDENCE=PASS");
