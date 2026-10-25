// ZEVANORY | WhatsApp onboarding — RETIRED.
//
// Meta permanently disabled the ZEVANORY WhatsApp Business account (WABA 4019600665012911) on
// 2026-10-10. This module used to host the Embedded Signup launcher/callback, transport
// finalization (app webhook subscription, WABA subscription, number registration, retried
// automatically on every panel load), and an operator "delivery proof" endpoint that built
// app-secret-signed fake inbound webhooks so the live bot answered a real number. All of that code
// is deleted: every onboarding route answers 410 Gone and nothing here calls the Graph API, the
// broker, or signs anything.
//
// What remains is read-only and Meta-free:
//   * loadVoiceGeminiKey: the Gemini voice key the owner once stored in the encrypted onboarding
//     record (voice support still uses it); WhatsApp credentials in that record are never returned.
//   * readWhatsappAuditObserve: historical observations from the operational store (no provider I/O).
//   * whatsappOnboardingStatus: constant retired status (no I/O).
import { getWhatsappOpsStore } from "./whatsapp-neon-store.mjs";
import { retiredWhatsappStatus, whatsappGoneResponse } from "./whatsapp-retirement.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromB64url(value){
  const s=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
  const p=s+"=".repeat((4-s.length%4)%4);
  return Uint8Array.from(atob(p),c=>c.charCodeAt(0));
}
async function keyFor(env){
  const material=String(env.ELITE_INTERNAL_TOKEN||env.OPERATOR_TOKEN||env.ZEVANORY_ADMIN_PASSWORD||"");
  if(material.length<24) throw new Error("whatsapp_onboarding_master_key_missing");
  return crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",encoder.encode("zevanory:whatsapp:onboarding:v1:"+material)),{name:"AES-GCM"},false,["decrypt"]);
}
async function open(value,env){
  const [a,b]=String(value||"").split(".");
  if(!a||!b) throw new Error("whatsapp_onboarding_ciphertext_invalid");
  const key=await keyFor(env);
  const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64url(a)},key,fromB64url(b));
  return JSON.parse(decoder.decode(decrypted));
}

// Only the voice key leaves this function. Access tokens, phone ids, app secret and verify token
// stored by the retired onboarding stay sealed and unused.
export async function loadVoiceGeminiKey(env={}){
  try {
    const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
    if(!kv?.get) return "";
    const raw=await kv.get("whatsapp-onboarding/runtime");
    if(!raw) return "";
    const record=await open(raw,env);
    const key=String(record?.gemini_api_key||"").trim();
    return key.length<=512?key:"";
  } catch { return ""; }
}

export async function whatsappOnboardingStatus(){
  return Object.freeze({ ...retiredWhatsappStatus(), configured:false, identity_verified:false, broker:false });
}

export async function readWhatsappAuditObserve(env,proofSql,owner){
 const kv=getWhatsappOpsStore(env,()=>proofSql()),observations=[];
 const digest=await crypto.subtle.digest("SHA-256",encoder.encode(owner.recipient));
 const contactHash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");
 const page=await kv.list({prefix:"whatsapp:observation:",limit:1000});
 for(const key of page.keys||[]){
  const value=await kv.get(key.name,{type:"json"});const item=typeof value==="string"?JSON.parse(value):value;
  if(item?.contact_hash===contactHash)observations.push(item);
 }
 observations.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
 const historyRaw=await kv.get("wa:conv:"+contactHash);
 return {recipient_suffix:owner.recipient_suffix,observations:observations.filter(x=>/^wamid\./.test(x.inbound_message_id||"")).slice(0,10),proof_observations:observations.filter(x=>String(x.inbound_message_id||"").startsWith("internal-")).slice(0,5),history:historyRaw?JSON.parse(historyRaw):[]};
}

export function isWhatsappOnboardingPath(pathname){
  const p=String(pathname||"");
  return p==="/admin/whatsapp-onboard"||p.startsWith("/admin/whatsapp-onboard/")||p==="/api/admin/whatsapp-onboard"||p.startsWith("/api/admin/whatsapp-onboard/");
}

// Every former route (start, callback, embedded-complete, bootstrap, finalize, voice-key, status,
// delivery-proof and the panel itself) is gone, whatever the method or credentials.
export async function handleWhatsappOnboarding(request){
  const url=new URL(request.url);
  if(!isWhatsappOnboardingPath(url.pathname)) return null;
  return whatsappGoneResponse(url.pathname);
}
