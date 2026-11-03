// NC-010 G03/G04: independent candidate service-binder only; NO production router,
// NO Hotmart/Resend network call, NO Cloudflare KV, NO secret in source.
import {resolveCpHotmartIngress,CpRoutingError} from "./cp-do-identity.mjs";
const encoder=new TextEncoder();
const hex=a=>[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function sha(v){return hex(await crypto.subtle.digest("SHA-256",encoder.encode(v)))}
async function mac(secret,text){
 const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return hex(await crypto.subtle.sign("HMAC",key,encoder.encode(text)));
}
function safeEq(a,b){if(a.length!==b.length||a.length<1)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0}
function validSecret(v){return typeof v==="string"&&v.length>=32}
const json=(status,payload)=>new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json"}});
export async function handleCpDoWebhookCandidate(request,env){
 try{
  // Nothing in this function can fall back to the legacy KV writer.
  const {stub,body,productId}=await resolveCpHotmartIngress(request,env);
  const event=String(body.event),data=body.data;
  const rawCycle=data?.purchase?.recurrence_number??data?.purchase?.recurrency_number;
  // No guessing missing recurrence; first cycle may explicitly be 1 in test payload.
  const cycle=Number(rawCycle);
  if(!Number.isInteger(cycle)||cycle<1||cycle>1200)
   return json(422,{ok:false,error:"recurrence_missing_or_invalid"});
  const kind=event==="PURCHASE_APPROVED"||event==="PURCHASE_COMPLETE"?"approved":
   ["PURCHASE_REFUNDED","PURCHASE_CHARGEBACK","PURCHASE_PROTEST","PURCHASE_CANCELED"].includes(event)?"refund_review":null;
  if(!kind)return json(422,{ok:false,error:"event_requires_manual_reconciliation"});
  const txn=String(data.purchase.transaction),status=String(data?.purchase?.status||"");
  const digest=await sha(["cp_event_v1",productId,txn,event,status].join("|"));
  const event_key="hm:"+digest;
  const intent={event_key,kind,cycle,at:new Date().toISOString()};
  const result=await stub.fetch("https://internal.cp.example/internal/apply",{
   method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(intent)});
  if(!result.ok)return json(result.status===403?403:503,{ok:false,error:"cp_do_commit_not_confirmed"});
  const rec=await result.json();
  // NO email nor content generation until outbox worker and canonical state are ready.
  return json(202,{ok:true,code:rec.code,cycle,delivery:"held_pending_cutover"});
 }catch(error){
  const e=error instanceof CpRoutingError?error:null;
  return json(e?e.status:503,{ok:false,error:e?.code||"cp_do_unavailable"});
 }
}
function urlEncode(data){return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(data)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"")}
function decodePayload(v){
 if(!/^[a-zA-Z0-9_-]{12,1500}$/.test(v))throw Error("bad_token_payload");
 const raw=atob(v.replace(/-/g,"+").replace(/_/g,"/"));
 return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw,ch=>ch.charCodeAt(0))));
}
async function checkedToken(token,env,now){
 const secret=env?.CP_FORM_SIGNING_KEY;
 if(!validSecret(secret)||typeof token!=="string")throw Error("cp_form_verifier_unavailable");
 const [payload,sig,extra]=token.split(".");
 if(extra!==undefined||!payload||!sig||!/^[a-f0-9]{64}$/.test(sig))throw Error("bad_form_token");
 if(!safeEq(await mac(secret,payload),sig))throw Error("bad_form_signature");
 const record=decodePayload(payload);
 if(record?.v!==1||!/^[a-f0-9]{64}$/.test(record?.s)||!Number.isInteger(record?.c)||record.c<1||
   !Number.isSafeInteger(record?.exp)||now>record.exp||record.exp-now>61*24*3600_000)
  throw Error("form_token_invalid_or_expired");
 return {record,hash:await sha(token)};
}
export async function issueCpFormTokenCandidate({opaqueRoutingId,cycle,expires_at_ms,env,event_key}){
 if(!/^[a-f0-9]{64}$/.test(opaqueRoutingId)||!Number.isInteger(cycle)||cycle<1||
   !Number.isSafeInteger(expires_at_ms)||expires_at_ms<Date.now()||expires_at_ms-Date.now()>60*24*3600_000||
   !validSecret(env?.CP_FORM_SIGNING_KEY)||!env.CP_SUBSCRIBER_DO?.idFromName||!env.CP_SUBSCRIBER_DO?.get)
  throw Error("form_issuer_unavailable");
 const payload=urlEncode({v:1,s:opaqueRoutingId,c:cycle,exp:expires_at_ms});
 const token=payload+"."+await mac(env.CP_FORM_SIGNING_KEY,payload);
 const token_sha256=await sha(token);
 const stub=env.CP_SUBSCRIBER_DO.get(env.CP_SUBSCRIBER_DO.idFromName("cp-verified:"+opaqueRoutingId));
 const response=await stub.fetch("https://internal.cp.example/internal/apply",{method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({kind:"form_token_issued",cycle,event_key,token_sha256,expires_at_ms})});
 if(!response.ok)throw Error("form_token_commit_failed");
 return {token,cycle,expires_at_ms,delivery:"OUTBOX_NOT_CONNECTED"};
}
export async function submitCpFormCandidate({token,form,env,now=Date.now()}){
 try{
  const {record,hash}=await checkedToken(token,env,now);
  if(!env?.CP_SUBSCRIBER_DO?.idFromName||!env.CP_SUBSCRIBER_DO?.get)throw Error("binding_missing");
  // Caller must perform business-field validation; this adapter only validates
  // token/cycle/size/atomicity, never trusts URL user identity.
  const serialized=JSON.stringify(form);
  if(!form||Array.isArray(form)||typeof form!=="object"||serialized.length>8192||serialized.length<2)
   return json(400,{ok:false,error:"invalid_form"});
  const form_sha256=await sha(serialized);
  const stub=env.CP_SUBSCRIBER_DO.get(env.CP_SUBSCRIBER_DO.idFromName("cp-verified:"+record.s));
  const response=await stub.fetch("https://internal.cp.example/internal/apply",{method:"POST",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({kind:"form_submitted",cycle:record.c,event_key:"form:"+hash.slice(0,64),
    token_sha256:hash,form_sha256,form_json:serialized,at:new Date(now).toISOString()})});
  if(!response.ok)return json(response.status===403?403:503,{ok:false,error:"form_not_committed"});
  const answer=await response.json();
  return json(202,{ok:true,code:answer.code,delivery:"held_pending_cutover"});
 }catch{return json(403,{ok:false,error:"form_token_invalid_or_unavailable"})}
}
