#!/usr/bin/env python3
import argparse,re
from pathlib import Path

HELPERS=r'''
const ZWA_OFFICIAL="5588992545413",ZWA_APP="1071149631917061";
const ZWA_REDIRECT="https://zevanory.api.br/admin/whatsapp-onboard/callback";
const ZWA_WEBHOOK="https://zevanory.api.br/api/webhooks/meta";
function zwaInternal(req){const u=new URL(req.url);return u.hostname==="whatsapp-broker.internal"&&req.headers.get("x-zevanory-internal")==="service-binding";}
function zwaDigits(v){return String(v||"").replace(/\D/g,"");}
async function zwaBody(req){try{return await req.json();}catch{return {};}}
async function zwaGraph(url,token,init={}){
  const h=new Headers(init.headers||{}); if(token)h.set("authorization","Bearer "+token);
  if(init.body&&!(init.body instanceof FormData)&&!h.has("content-type"))h.set("content-type","application/json");
  const r=await fetch(url,{...init,headers:h,signal:AbortSignal.timeout(20000)});
  const b=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error("graph_http_"+r.status+":"+safe(b?.error?.message||"provider_error",300));
  return b;
}
async function zwaKey(env){
  const raw=new TextEncoder().encode(String(env.META_APP_SECRET||"")+":"+String(env.ADMIN_TOKEN||""));
  return crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",raw),{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
function zwaB64(a){let s="";for(const b of a)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function zwaUnb64(v){const s=String(v||"").replace(/-/g,"+").replace(/_/g,"/");const p=s+"=".repeat((4-s.length%4)%4);return Uint8Array.from(atob(p),c=>c.charCodeAt(0));}
async function zwaSeal(env,obj){const iv=crypto.getRandomValues(new Uint8Array(12)),k=await zwaKey(env),d=new TextEncoder().encode(JSON.stringify(obj));const e=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},k,d));return zwaB64(iv)+"."+zwaB64(e);}
async function zwaOpen(env,v){const [a,b]=String(v||"").split(".");if(!a||!b)return null;const k=await zwaKey(env);const d=await crypto.subtle.decrypt({name:"AES-GCM",iv:zwaUnb64(a)},k,zwaUnb64(b));return JSON.parse(new TextDecoder().decode(d));}
async function zwaTable(env){await env.DB.prepare("CREATE TABLE IF NOT EXISTS whatsapp_runtime_config (k TEXT PRIMARY KEY,sealed TEXT NOT NULL,updated_at TEXT NOT NULL)").run();}
async function zwaRuntime(env){
  try{await zwaTable(env);const r=await env.DB.prepare("SELECT sealed FROM whatsapp_runtime_config WHERE k='meta_runtime' LIMIT 1").first();if(r?.sealed){const x=await zwaOpen(env,r.sealed);if(x?.access_token&&x?.phone_number_id)return x;}}catch{}
  return {access_token:String(env.WHATSAPP_ACCESS_TOKEN||""),phone_number_id:String(env.WHATSAPP_PHONE_NUMBER_ID||""),waba_id:"",graph_version:String(env.GRAPH_API_VERSION||"v26.0")};
}
async function zwaWriteRuntime(env,x){await zwaTable(env);const s=await zwaSeal(env,x);await env.DB.prepare("INSERT INTO whatsapp_runtime_config(k,sealed,updated_at) VALUES('meta_runtime',?,?) ON CONFLICT(k) DO UPDATE SET sealed=excluded.sealed,updated_at=excluded.updated_at").bind(s,nowIso()).run();}
async function zwaFindNumber(token,version,official){
  let businesses={data:[]};try{businesses=await zwaGraph("https://graph.facebook.com/"+version+"/me/businesses?fields=id,name&limit=100",token);}catch{}
  for(const business of businesses.data||[]){let ws={data:[]};try{ws=await zwaGraph("https://graph.facebook.com/"+version+"/"+business.id+"/owned_whatsapp_business_accounts?fields=id,name&limit=100",token);}catch{continue;}
    for(const waba of ws.data||[]){let ps={data:[]};try{ps=await zwaGraph("https://graph.facebook.com/"+version+"/"+waba.id+"/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,new_name_status&limit=100",token);}catch{continue;}
      for(const phone of ps.data||[])if(zwaDigits(phone.display_phone_number)===official)return {business,waba,phone};
    }
  }return null;
}
async function zwaStatus(env){
  const x=await zwaRuntime(env),token=String(x.access_token||""),pid=String(x.phone_number_id||""),v=String(x.graph_version||env.GRAPH_API_VERSION||"v26.0");
  if(!token||!pid)return {broker:true,configured:false,identity_verified:false,reason:"credentials_missing"};
  try{const p=await zwaGraph("https://graph.facebook.com/"+v+"/"+pid+"?fields="+encodeURIComponent("id,display_phone_number,verified_name,name_status,new_name_status,quality_rating,code_verification_status"),token);
    const numberOk=String(p.id||"")===pid&&zwaDigits(p.display_phone_number)===ZWA_OFFICIAL,brandOk=String(p.verified_name||"").trim().toUpperCase()==="ZEVANORY",ns=String(p.name_status||"").toUpperCase(),nameOk=["APPROVED","AVAILABLE_WITHOUT_REVIEW"].includes(ns);
    return {broker:true,configured:true,identity_verified:numberOk&&brandOk&&nameOk,phone_number_id:pid,waba_id:String(x.waba_id||""),display_phone_number:zwaDigits(p.display_phone_number),number_verified:numberOk,verified_name:safe(p.verified_name,200),brand_name_verified:brandOk,name_status:ns,new_name_status:safe(p.new_name_status,100),quality_rating:safe(p.quality_rating,100),code_verification_status:safe(p.code_verification_status,100),app_secret_valid:Boolean(env.META_APP_SECRET),verify_token_valid:Boolean(env.WHATSAPP_VERIFY_TOKEN),graph_version:v};
  }catch(e){return {broker:true,configured:true,identity_verified:false,phone_number_id:pid,waba_id:String(x.waba_id||""),reason:safe(e?.message,240)};}
}
async function zwaOauth(env,b){
  const code=safe(b?.code,4000),official=zwaDigits(b?.official_e164||ZWA_OFFICIAL),v=String(env.GRAPH_API_VERSION||"v26.0");
  if(!code||official!==ZWA_OFFICIAL)throw new Error("oauth_callback_invalid");
  const u=new URL("https://graph.facebook.com/"+v+"/oauth/access_token");u.searchParams.set("client_id",ZWA_APP);u.searchParams.set("redirect_uri",safe(b?.redirect_uri,1000)||ZWA_REDIRECT);u.searchParams.set("client_secret",String(env.META_APP_SECRET||""));u.searchParams.set("code",code);
  const short=await zwaGraph(u.toString(),"");const token=String(short.access_token||"");if(!token)throw new Error("oauth_token_missing");
  const found=await zwaFindNumber(token,v,official);if(!found)return {broker:true,official_number_found:false,identity_verified:false,reason:"official_number_not_found"};
  const pid=String(found.phone.id),wid=String(found.waba.id);
  let webhook=false,subscribed=false,registered=false;
  try{const au=new URL("https://graph.facebook.com/"+v+"/oauth/access_token");au.searchParams.set("client_id",ZWA_APP);au.searchParams.set("client_secret",String(env.META_APP_SECRET||""));au.searchParams.set("grant_type","client_credentials");const aj=await zwaGraph(au.toString(),"");const form=new URLSearchParams({object:"whatsapp_business_account",callback_url:ZWA_WEBHOOK,verify_token:String(env.WHATSAPP_VERIFY_TOKEN||""),fields:"messages",include_values:"true"});const rr=await fetch("https://graph.facebook.com/"+v+"/"+ZWA_APP+"/subscriptions",{method:"POST",headers:{authorization:"Bearer "+String(aj.access_token||""),"content-type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(20000)});const rj=await rr.json().catch(()=>({}));webhook=rr.ok&&rj?.success===true;}catch{}
  try{subscribed=(await zwaGraph("https://graph.facebook.com/"+v+"/"+wid+"/subscribed_apps",token,{method:"POST",body:JSON.stringify({subscribed_fields:["messages"]})}))?.success===true;}catch{}
  const pin=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
  try{registered=(await zwaGraph("https://graph.facebook.com/"+v+"/"+pid+"/register",token,{method:"POST",body:JSON.stringify({messaging_product:"whatsapp",pin})}))?.success===true;}catch(e){registered=/already|registered/i.test(String(e?.message||""));}
  await zwaWriteRuntime(env,{access_token:token,phone_number_id:pid,waba_id:wid,graph_version:v,two_step_pin:pin,updated_at:nowIso()});
  return {broker:true,official_number_found:true,webhook_configured:webhook,waba_subscribed:subscribed,phone_registration_ok:registered,...await zwaStatus(env)};
}
'''

ROUTES=r'''
    if(url.pathname.startsWith("/broker/")){
      if(!zwaInternal(request))return json({ok:false,error:"not_found"},404);
      if(request.method==="GET"&&url.pathname==="/broker/status")return json(await zwaStatus(env));
      if(request.method==="POST"&&url.pathname==="/broker/verify-token"){const b=await zwaBody(request);return json({valid:Boolean(b?.token)&&String(b.token)===String(env.WHATSAPP_VERIFY_TOKEN||"")});}
      if(request.method==="POST"&&url.pathname==="/broker/verify-signature"){const b=await zwaBody(request),p=String(b?.payload||""),s=String(b?.signature||"");if(!s.startsWith("sha256=")||!env.META_APP_SECRET)return json({valid:false});const e=await hmacHex(String(env.META_APP_SECRET),new TextEncoder().encode(p));return json({valid:s.slice(7).toLowerCase()===e.toLowerCase()});}
      if(request.method==="POST"&&url.pathname==="/broker/send"){const b=await zwaBody(request),x=await zwaRuntime(env),t=String(x.access_token||""),p=String(x.phone_number_id||""),v=String(x.graph_version||env.GRAPH_API_VERSION||"v26.0");if(!t||!p||!b?.message)return json({error:"whatsapp_not_configured"},503);return json(await zwaGraph("https://graph.facebook.com/"+v+"/"+p+"/messages",t,{method:"POST",body:JSON.stringify(b.message)}));}
      if(request.method==="POST"&&url.pathname==="/broker/media"){const x=await zwaRuntime(env),t=String(x.access_token||""),p=String(x.phone_number_id||""),v=String(x.graph_version||env.GRAPH_API_VERSION||"v26.0");if(!t||!p)return json({error:"whatsapp_not_configured"},503);const bytes=await request.arrayBuffer(),form=new FormData();form.append("messaging_product","whatsapp");form.append("file",new Blob([bytes],{type:request.headers.get("content-type")||"application/octet-stream"}),request.headers.get("x-zevanory-filename")||"zevanory-media.bin");const r=await fetch("https://graph.facebook.com/"+v+"/"+p+"/media",{method:"POST",headers:{authorization:"Bearer "+t},body:form,signal:AbortSignal.timeout(20000)}),j=await r.json().catch(()=>({}));return r.ok&&j?.id?json({media_id:String(j.id)}):json({error:"media_upload_failed",provider_status:r.status},502);}
      if(request.method==="POST"&&url.pathname==="/broker/oauth/callback"){try{return json(await zwaOauth(env,await zwaBody(request)));}catch(e){return json({broker:true,identity_verified:false,error:safe(e?.message,240)},502);}}
      return json({ok:false,error:"broker_route_not_found"},404);
    }
'''

def extract(raw):
    t=raw.decode("utf-8","replace")
    js=t.find("var __defProp")
    if js<0: raise SystemExit("broker_js_start_missing")
    marker="//# sourceMappingURL=index.js.map"
    sm=t.find(marker,js)
    if sm>=0:
        nl=t.find("\n",sm)
        return t[js:(nl+1 if nl>=0 else len(t))]
    # Fallback for builds without source-map trailer: stop at multipart boundary.
    first=t.splitlines()[0].strip()
    e=t.find("\r\n"+first,js)
    if e<0: e=t.find("\n"+first,js)
    if e<0: e=len(t)
    return t[js:e]
def patch(src):
    required=["/broker/status","/broker/send","/broker/media","/broker/verify-signature","/broker/verify-token","/broker/oauth/callback"]
    present=[x for x in required if x in src]
    if present:
        if len(present)!=len(required):
            raise SystemExit("partial_broker_protocol:"+",".join(present))
        print("WHATSAPP_BROKER_PROTOCOL_ALREADY_COMPLETE=PASS")
        return src
    if "var index_default = {" not in src or '    const url = new URL(request.url);\n' not in src: raise SystemExit("anchor_missing")
    src=src.replace("var index_default = {",HELPERS+"\nvar index_default = {",1)
    src=src.replace('    const url = new URL(request.url);\n','    const url = new URL(request.url);\n'+ROUTES+"\n",1)
    for x in ["/broker/status","/broker/send","/broker/media","/broker/verify-signature","/broker/verify-token","/broker/oauth/callback","whatsapp_runtime_config"]:
        if x not in src: raise SystemExit("patch_missing_"+x)
    return src
def main():
    a=argparse.ArgumentParser();a.add_argument("--multipart",required=True);a.add_argument("--out",required=True);x=a.parse_args()
    p=patch(extract(Path(x.multipart).read_bytes()));Path(x.out).write_text(p,encoding="utf-8")
    print("WHATSAPP_BROKER_PROTOCOL_PATCH=PASS");print("PATCHED_BYTES="+str(len(p.encode())))
if __name__=="__main__":main()
