// WhatsApp channel retired (Meta permanently disabled WABA 4019600665012911 on 2026-10-10).
// The former "delivery proof" built app-secret-signed fake inbound webhooks so the live bot replied
// to a real number. This test now proves the opposite: every operation of that route, and every
// other onboarding route, is 410 Gone for any method/credential and nothing reaches the network.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleWhatsappOnboarding } from "../worker/whatsapp-onboarding.mjs";
globalThis.crypto ||= webcrypto;
const operator="synthetic-operator-at-least-32-characters";
const env={ELITE_INTERNAL_TOKEN:"synthetic-master-key-at-least-32-characters",OPERATOR_TOKEN:operator,CERTIFICATION_E2E_TOKEN:operator,ZEVANORY_PRIVATE_ARTIFACTS:{get:async()=>{throw new Error("must_not_read_kv");}}};
let calls=0;const realFetch=globalThis.fetch;
globalThis.fetch=async()=>{calls++;throw new Error("network_forbidden_for_retired_whatsapp");};
const ops=["subscriptions","owner","text","audio","audit-cache","audit-encode","audit-transcribe","audit-observe","audit-media","audit-encoder-key","audit-source","arbitrary-send"];
for(const operation of ops)for(const auth of [true,false]){
  const r=await handleWhatsappOnboarding(new Request("https://zevanory.api.br/api/admin/whatsapp-onboard/delivery-proof",{method:"POST",headers:auth?{authorization:"Bearer "+operator}:{},body:JSON.stringify({operation,audio_base64:Buffer.from("OggS").toString("base64")})}),env);
  assert.equal(r.status,410,operation);const body=await r.json();
  assert.equal(body.error,"whatsapp_channel_retired");assert.equal(body.reason,"meta_account_permanently_disabled");
  assert.ok(!("signed_body" in body)&&!("signature" in body),"no signed payload is ever returned");
}
for(const [path,method] of [["/admin/whatsapp-onboard","GET"],["/admin/whatsapp-onboard/start","GET"],["/admin/whatsapp-onboard/callback?code=x&state=y","GET"],["/admin/whatsapp-onboard/embedded-complete","POST"],["/admin/whatsapp-onboard/bootstrap","POST"],["/admin/whatsapp-onboard/finalize","POST"],["/admin/whatsapp-onboard/voice-key","POST"],["/api/admin/whatsapp-onboard/status","GET"]]){
  const r=await handleWhatsappOnboarding(new Request("https://zevanory.api.br"+path,{method,headers:{authorization:"Bearer "+operator},body:method==="POST"?"{}":undefined}),env);
  assert.equal(r.status,410,path);
}
assert.equal(await handleWhatsappOnboarding(new Request("https://zevanory.api.br/api/status"),env),null);
assert.equal(calls,0,"no fetch at all");
globalThis.fetch=realFetch;
console.log("DELIVERY_PROOF_AND_ONBOARDING_RETIRED_410_NO_NETWORK_NO_SIGNATURE=PASS");

const {ttsBytesWithFailover}=await import("../worker/voice-provider-router.mjs");
const attempted=[];
await assert.rejects(()=>ttsBytesWithFailover("Olá",{VOICE_TTS_FREE_ONLY:"true",GEMINI_API_KEY:"synthetic",GEMINI_FREE_TIER_CONFIRMED:"true",VOICE_TTS_PROVIDER_CHAIN:"gemini",GEMINI_TTS_MODEL:"gemini-2.5-legacy"},async(url,init)=>{const b=JSON.parse(init.body);attempted.push(b.model);assert.ok(init.signal instanceof AbortSignal);return Response.json({error:{code:404}},{status:404});}),/voice_tts_all_providers_failed/);
assert.deepEqual(attempted,["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]);
console.log("GEMINI_TWO_CURRENT_MODELS_FAILOVER_NO_LEGACY=PASS");

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

