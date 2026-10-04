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
const proofOptions={proofSql:()=>({query:async(query)=>{
 if(query.startsWith("select contact_ref"))return [{contact_ref:"5511999991234",updated_at:"2026-10-04T19:55:00Z"}];
 return [{payload:{message_id:"wamid.realtext",inbound_message:"so texto",media_type:"text"},created_at:"2026-10-04T19:55:00Z"},{payload:{message_id:"wamid.realaudio",media_type:"audio"},created_at:"2026-10-04T19:54:00Z"}];
}})};
const handle=(req,env)=>handleWhatsappOnboarding(req,env,proofOptions);
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
  assert.equal(msg.from,"5511999991234");assert.match(msg.id,/^internal-(text|audio)-/);
  if(msg.type==="text")assert.equal(msg.text.body,"teste interno: quanto custa o combo?");
  else assert.equal(msg.audio.id,"synthetic-media");
  return Response.json({accepted:true});
};
assert.equal((await handle(request({operation:"text"},false),env)).status,401);assert.equal(calls,0);
assert.equal((await handle(request({operation:"arbitrary-send"}),env)).status,400);assert.equal(calls,0);
const subscriptions=await handle(request({operation:"subscriptions"}),env);assert.equal((await subscriptions.json()).valid,true);
const text=await handle(request({operation:"text",recipient:"ignored-attacker-target"}),env);
const proof=await text.json();assert.equal(proof.signature,"sha256="+createHmac("sha256",record.app_secret).update(proof.signed_body).digest("hex"));assert.equal(JSON.parse(proof.signed_body).entry[0].changes[0].value.messages[0].from,"5511999991234");assert.ok(proof.body_sha256);assert.ok(!JSON.stringify(proof).includes(record.app_secret));
const audio=await handle(request({operation:"audio",audio_base64:Buffer.from("OggSsynthetic-unit-test").toString("base64")}),env);
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
assert.equal((await handle(certRequest,certEnv)).status,200);
assert.equal((await handle(request({operation:"subscriptions"}),certEnv)).status,401);
console.log("DEDICATED_CERTIFICATION_AUTHORITY_PRECEDENCE=PASS");

const {whatsappInboundSafety,resolveOwnerProof}=await import("../worker/whatsapp-inbound-safety.mjs");
for(const from of ["558892545413","5588992545413","+55 (88) 9254-5413"])assert.equal(whatsappInboundSafety({from,phone_number_id:"1300972319774588"}),"self_sender");
assert.equal(whatsappInboundSafety({from:"5511999991234",phone_number_id:"other"}),"phone_number_mismatch");
assert.equal(whatsappInboundSafety({from:"5511999991234",phone_number_id:"1300972319774588"}),null);
await assert.rejects(()=>resolveOwnerProof({query:async()=>[{contact_ref:"5511999995678",updated_at:"2026-10-04T19:55:00Z"}]}),/owner_proof_evidence_not_found/);
const recovered=await import("node:fs").then(fs=>fs.readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs",import.meta.url),"utf8"));
assert.ok(recovered.includes("if (whatsappInboundSafety(item)) continue;"));
assert.ok(recovered.includes("const safetyReason = whatsappInboundSafety(item);"));
console.log("SELF_SENDER_BOTH_FORMATS_PHONE_ID_OWNER_EVIDENCE_GUARDS=PASS");

const candidate="5511999991234";
const kvHash=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(candidate))).toString("hex");
const fallbackSql={query:async q=>q.startsWith("select contact_ref")?[{contact_ref:candidate,updated_at:"2026-10-04T19:55:31Z"}]:q.startsWith("select m.")?[]:[{created_at:"2026-10-04T19:55:10Z",payload:{message_id:"wamid.audio",media_type:"audio",inbound_message:"Tenho uma loja"}},{created_at:"2026-10-04T19:35:28Z",payload:{message_id:"wamid.text",media_type:"text",inbound_message:"Tenho uma loja"}}]};
const proofKv={list:async()=>({keys:[{name:"whatsapp-e2e/"+Date.parse("2026-10-04T19:55:31Z")+"-test"}],list_complete:true}),get:async()=>({type:"inbound_processed",phone_number_id:"1300972319774588",contact_hash:kvHash,created_at:"2026-10-04T19:55:31Z"})};
assert.equal((await resolveOwnerProof(fallbackSql,proofKv)).recipient_suffix,"1234");
await assert.rejects(()=>resolveOwnerProof(fallbackSql,{...proofKv,get:async()=>({type:"inbound_processed",phone_number_id:"other",contact_hash:kvHash})}),/owner_proof_evidence_not_found/);
await assert.rejects(()=>resolveOwnerProof(fallbackSql,{...proofKv,get:async()=>({type:"inbound_processed",phone_number_id:"1300972319774588",contact_hash:"wrong-contact"})}),/owner_proof_evidence_not_found/);
console.log("OWNER_AUDIO_TIMESTAMP_KV_CONTACT_PHONE_CROSSCHECK=PASS");

const newerAudioSql={query:async q=>q.startsWith("select contact_ref")?[{contact_ref:candidate,updated_at:"2026-10-04T22:36:33Z"}]:q.startsWith("select m.")?[]:[{created_at:"2026-10-04T22:36:21Z",payload:{message_id:"wamid.newaudio",media_type:"audio"}},...await fallbackSql.query(q)]};
assert.equal((await resolveOwnerProof(newerAudioSql,proofKv)).recipient_suffix,"1234");
console.log("NEW_REAL_AUDIO_PRESERVES_VERIFIED_OWNER_ANCHOR=PASS");
