const OFFICIAL_E164 = "5588992545413";
const DEFAULT_APP_ID = "1071149631917061";
const DEFAULT_CONFIG_ID = "1138959298884634";
const GRAPH_VERSION = "v26.0";
const CALLBACK_URL = "https://zevanory.api.br/api/webhooks/meta";
const OAUTH_REDIRECT = "https://zevanory.api.br/admin/whatsapp-onboard/callback";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
}
function clean(v,max=500){ return String(v??"").trim().slice(0,max); }
function digits(v){ return clean(v,120).replace(/\D/g,""); }
function internal(request){
  const u=new URL(request.url);
  return u.hostname==="whatsapp-broker.internal" && request.headers.get("x-zevanory-internal")==="service-binding";
}
function bytesToB64(bytes){ return btoa(String.fromCharCode(...bytes)); }
function b64ToBytes(v){ return Uint8Array.from(atob(String(v||"")),c=>c.charCodeAt(0)); }

async function cryptoKey(env){
  const secret=clean(env.META_APP_SECRET,4000);
  if(secret.length<16) throw new Error("meta_app_secret_missing");
  const raw=await crypto.subtle.digest("SHA-256",encoder.encode("zevanory:whatsapp:broker:v1:"+secret));
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function seal(text,env){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await cryptoKey(env);
  const out=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(String(text))));
  return bytesToB64(iv)+"."+bytesToB64(out);
}
async function open(cipher,env){
  const [a,b]=String(cipher||"").split(".");
  if(!a||!b) return "";
  const key=await cryptoKey(env);
  const out=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64ToBytes(a)},key,b64ToBytes(b));
  return decoder.decode(out);
}
async function ensureSchema(env){
  if(!env.DB?.prepare) throw new Error("broker_db_missing");
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS zevanory_whatsapp_broker_runtime(
    id INTEGER PRIMARY KEY CHECK(id=1),
    access_token_cipher TEXT,
    phone_number_id TEXT,
    waba_id TEXT,
    two_step_pin_cipher TEXT,
    app_id TEXT,
    updated_at TEXT
  )`).run();
}
async function runtime(env){
  await ensureSchema(env);
  const row=await env.DB.prepare("SELECT * FROM zevanory_whatsapp_broker_runtime WHERE id=1").first();
  return row||null;
}
async function storeRuntime(env,{access_token,phone_number_id=null,waba_id=null,pin=null,app_id=DEFAULT_APP_ID}={}){
  await ensureSchema(env);
  const previous=await runtime(env);
  const tokenCipher=access_token?await seal(access_token,env):previous?.access_token_cipher||null;
  const pinCipher=pin?await seal(pin,env):previous?.two_step_pin_cipher||null;
  await env.DB.prepare(`INSERT INTO zevanory_whatsapp_broker_runtime(id,access_token_cipher,phone_number_id,waba_id,two_step_pin_cipher,app_id,updated_at)
    VALUES(1,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      access_token_cipher=excluded.access_token_cipher,
      phone_number_id=COALESCE(excluded.phone_number_id,zevanory_whatsapp_broker_runtime.phone_number_id),
      waba_id=COALESCE(excluded.waba_id,zevanory_whatsapp_broker_runtime.waba_id),
      two_step_pin_cipher=COALESCE(excluded.two_step_pin_cipher,zevanory_whatsapp_broker_runtime.two_step_pin_cipher),
      app_id=excluded.app_id,
      updated_at=excluded.updated_at`)
    .bind(tokenCipher,phone_number_id,waba_id,pinCipher,app_id,new Date().toISOString()).run();
}
async function accessToken(env){
  const r=await runtime(env).catch(()=>null);
  if(r?.access_token_cipher){
    try { const t=await open(r.access_token_cipher,env); if(t) return t; } catch {}
  }
  return clean(env.WHATSAPP_ACCESS_TOKEN,6000);
}
async function graph(path,{env,token,method="GET",body=null,form=false}={}){
  const t=token||await accessToken(env);
  if(!t) throw new Error("whatsapp_access_token_missing");
  const headers={authorization:"Bearer "+t};
  let payload=null;
  if(body!==null){
    if(form){
      headers["content-type"]="application/x-www-form-urlencoded";
      payload=body instanceof URLSearchParams?body:new URLSearchParams(body);
    }else{
      headers["content-type"]="application/json";
      payload=JSON.stringify(body);
    }
  }
  const r=await fetch("https://graph.facebook.com/"+GRAPH_VERSION+"/"+path,{method,headers,body:payload,signal:AbortSignal.timeout(20000)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error("graph_http_"+r.status+"_"+clean(data?.error?.code||"",30)+"_"+clean(data?.error?.message||"provider_error",180).replace(/\s+/g,"_"));
  return data;
}
async function permissions(env,token){
  try{
    const p=await graph("me/permissions",{env,token});
    const granted=(p.data||[]).filter(x=>String(x.status||"").toLowerCase()==="granted").map(x=>String(x.permission||"")).filter(Boolean);
    const s=new Set(granted);
    return {
      business_management:s.has("business_management"),
      whatsapp_business_management:s.has("whatsapp_business_management"),
      whatsapp_business_messaging:s.has("whatsapp_business_messaging")
    };
  }catch{
    return {business_management:false,whatsapp_business_management:false,whatsapp_business_messaging:false};
  }
}
async function appInfo(env,token){
  try{
    const a=await graph("app?fields=id,name",{env,token});
    return {id:clean(a.id,64),name:clean(a.name,120)};
  }catch{return {id:"",name:""};}
}
async function appAccessToken(env,appId=DEFAULT_APP_ID){
  const secret=clean(env.META_APP_SECRET,4000);
  if(!secret) throw new Error("meta_app_secret_missing");
  const u=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token");
  u.searchParams.set("client_id",appId);
  u.searchParams.set("client_secret",secret);
  u.searchParams.set("grant_type","client_credentials");
  const r=await fetch(u,{signal:AbortSignal.timeout(15000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.access_token) throw new Error("meta_app_secret_mismatch");
  return String(j.access_token);
}
async function appSecretValid(env,appId=DEFAULT_APP_ID){
  try{return Boolean(await appAccessToken(env,appId));}catch{return false;}
}
async function exchangeCode(env,code,redirectUri){
  const appId=DEFAULT_APP_ID, secret=clean(env.META_APP_SECRET,4000);
  if(!secret) throw new Error("meta_app_secret_missing");
  const u=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token");
  u.searchParams.set("client_id",appId);
  u.searchParams.set("redirect_uri",redirectUri);
  u.searchParams.set("client_secret",secret);
  u.searchParams.set("code",code);
  const r=await fetch(u,{signal:AbortSignal.timeout(20000)});
  const short=await r.json().catch(()=>({}));
  if(!r.ok||!short.access_token) throw new Error("meta_oauth_exchange_failed");
  const x=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token");
  x.searchParams.set("grant_type","fb_exchange_token");
  x.searchParams.set("client_id",appId);
  x.searchParams.set("client_secret",secret);
  x.searchParams.set("fb_exchange_token",short.access_token);
  const lr=await fetch(x,{signal:AbortSignal.timeout(20000)});
  const long=await lr.json().catch(()=>({}));
  return String(long.access_token||short.access_token);
}
async function discoverOfficial(env,token){
  const businesses=await graph("me/businesses?fields=id,name&limit=100",{env,token});
  for(const business of businesses.data||[]){
    let wab;
    try{wab=await graph(encodeURIComponent(business.id)+"/owned_whatsapp_business_accounts?fields=id,name&limit=100",{env,token});}
    catch{continue;}
    for(const waba of wab.data||[]){
      let phones;
      try{phones=await graph(encodeURIComponent(waba.id)+"/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,new_name_status&limit=100",{env,token});}
      catch{continue;}
      for(const phone of phones.data||[]){
        if(digits(phone.display_phone_number)===OFFICIAL_E164) return {business,waba,phone};
      }
    }
  }
  return null;
}
async function phoneIdentity(env,phoneId,token){
  if(!phoneId) return {number_verified:false,identity_verified:false,reason:"phone_number_id_missing"};
  try{
    const p=await graph(encodeURIComponent(phoneId)+"?fields=id,display_phone_number,verified_name,name_status,new_name_status,quality_rating,code_verification_status",{env,token});
    const numberVerified=String(p.id||"")===String(phoneId)&&digits(p.display_phone_number)===OFFICIAL_E164;
    const brand=clean(p.verified_name,160).toUpperCase()==="ZEVANORY";
    const nameStatus=clean(p.name_status,80).toUpperCase();
    const nameOk=["APPROVED","AVAILABLE_WITHOUT_REVIEW"].includes(nameStatus);
    return {
      number_verified:numberVerified,
      brand_name_verified:brand,
      identity_verified:numberVerified&&brand&&nameOk,
      phone_number_id:String(p.id||""),
      display_phone_number:digits(p.display_phone_number),
      verified_name:clean(p.verified_name,160),
      name_status:nameStatus,
      new_name_status:clean(p.new_name_status,80).toUpperCase(),
      quality_rating:clean(p.quality_rating,80),
      code_verification_status:clean(p.code_verification_status,80).toUpperCase(),
      reason:numberVerified?(brand?(nameOk?"identity_match":"brand_display_name_not_ready"):"brand_display_name_mismatch"):"number_identity_mismatch"
    };
  }catch(error){
    return {number_verified:false,identity_verified:false,reason:clean(error?.message,180)};
  }
}
async function status(env){
  const r=await runtime(env).catch(()=>null);
  const token=await accessToken(env);
  const phoneId=clean(r?.phone_number_id,120);
  const perms=token?await permissions(env,token):{business_management:false,whatsapp_business_management:false,whatsapp_business_messaging:false};
  const app=token?await appInfo(env,token):{id:"",name:""};
  const identity=phoneId?await phoneIdentity(env,phoneId,token):{number_verified:false,identity_verified:false,reason:"official_number_not_discovered"};
  const valid=await appSecretValid(env,app.id||DEFAULT_APP_ID);
  return {
    broker:true,
    configured:Boolean(token&&clean(env.META_APP_SECRET,4000)&&clean(env.WHATSAPP_VERIFY_TOKEN,4000)),
    zero_spend:true,
    official_e164:OFFICIAL_E164,
    official_number_found:Boolean(phoneId&&identity.number_verified),
    identity_verified:Boolean(identity.identity_verified),
    app_secret_valid:valid,
    token_app_id:app.id||null,
    token_app_name:app.name||null,
    waba_id:r?.waba_id||null,
    graph_version:GRAPH_VERSION,
    permissions:perms,
    ...identity
  };
}
async function configureWebhook(env,wabaId,token){
  const appId=DEFAULT_APP_ID;
  const appToken=await appAccessToken(env,appId);
  const form=new URLSearchParams({
    object:"whatsapp_business_account",
    callback_url:CALLBACK_URL,
    verify_token:clean(env.WHATSAPP_VERIFY_TOKEN,4000),
    fields:"messages",
    include_values:"true"
  });
  const sub=await graph(encodeURIComponent(appId)+"/subscriptions",{env,token:appToken,method:"POST",body:form,form:true});
  const w=await graph(encodeURIComponent(wabaId)+"/subscribed_apps",{env,token,method:"POST",body:{subscribed_fields:["messages"]}});
  return {webhook_configured:sub?.success===true,waba_subscribed:w?.success===true};
}
async function registerPhone(env,phoneId,token,pin){
  try{
    const r=await graph(encodeURIComponent(phoneId)+"/register",{env,token,method:"POST",body:{messaging_product:"whatsapp",pin}});
    return {ok:r?.success===true,already:false};
  }catch(error){
    const m=clean(error?.message,180);
    if(/already|registered/i.test(m)) return {ok:true,already:true};
    return {ok:false,already:false,reason:m};
  }
}
async function oauthCallback(env,body){
  const code=clean(body?.code,5000), redirect=clean(body?.redirect_uri,1000);
  if(!code||redirect!==OAUTH_REDIRECT) throw new Error("oauth_callback_invalid");
  const token=await exchangeCode(env,code,redirect);
  const perms=await permissions(env,token);
  const found=await discoverOfficial(env,token);
  if(!found){
    await storeRuntime(env,{access_token:token,app_id:DEFAULT_APP_ID});
    return {authorized:true,official_number_found:false,identity_verified:false,requires_number_addition:true,permissions:perms};
  }
  const phoneId=String(found.phone.id),wabaId=String(found.waba.id);
  const pin=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
  await storeRuntime(env,{access_token:token,phone_number_id:phoneId,waba_id:wabaId,pin,app_id:DEFAULT_APP_ID});
  let webhook={webhook_configured:false,waba_subscribed:false};
  try{webhook=await configureWebhook(env,wabaId,token);}catch{}
  const registration=await registerPhone(env,phoneId,token,pin);
  const identity=await phoneIdentity(env,phoneId,token);
  return {authorized:true,official_number_found:true,waba_id:wabaId,phone_number_id:phoneId,permissions:perms,...webhook,phone_registration_ok:Boolean(registration.ok),...identity};
}
async function requestCode(env,body){
  const r=await runtime(env), token=await accessToken(env), phoneId=clean(r?.phone_number_id,120);
  if(!phoneId) throw new Error("official_phone_number_id_missing");
  const method=String(body?.code_method||"SMS").toUpperCase()==="VOICE"?"VOICE":"SMS";
  const out=await graph(encodeURIComponent(phoneId)+"/request_code",{env,token,method:"POST",body:{code_method:method,locale:"pt_BR"}});
  return {success:out?.success===true,method};
}
async function verifyCode(env,body){
  const code=digits(body?.code);
  if(!/^\d{6}$/.test(code)) throw new Error("verification_code_invalid");
  const r=await runtime(env), token=await accessToken(env), phoneId=clean(r?.phone_number_id,120);
  if(!phoneId) throw new Error("official_phone_number_id_missing");
  const out=await graph(encodeURIComponent(phoneId)+"/verify_code",{env,token,method:"POST",body:{code}});
  let registered=false;
  if(out?.success===true){
    let pin="";
    try{pin=r?.two_step_pin_cipher?await open(r.two_step_pin_cipher,env):"";}catch{}
    if(!pin){pin=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");await storeRuntime(env,{pin});}
    const reg=await registerPhone(env,phoneId,token,pin);
    registered=Boolean(reg.ok);
  }
  const identity=await phoneIdentity(env,phoneId,token);
  return {success:out?.success===true,phone_registration_ok:registered,...identity};
}
async function signatureValid(env,payload,signature){
  const secret=clean(env.META_APP_SECRET,4000);
  const supplied=clean(signature,200);
  if(!secret||!supplied.startsWith("sha256=")) return false;
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(String(payload||""))));
  const expected="sha256="+[...sig].map(x=>x.toString(16).padStart(2,"0")).join("");
  if(expected.length!==supplied.length) return false;
  let diff=0;for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^supplied.charCodeAt(i);
  return diff===0;
}
function constantEqual(a,b){
  a=String(a||"");b=String(b||"");if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;
}
async function sendMessage(env,message){
  const s=await status(env);
  if(!s.identity_verified||!s.phone_number_id) throw new Error("official_number_not_verified");
  const token=await accessToken(env);
  const m={...message,messaging_product:"whatsapp"};
  if(digits(m.to).length<8) throw new Error("recipient_invalid");
  const out=await graph(encodeURIComponent(s.phone_number_id)+"/messages",{env,token,method:"POST",body:m});
  const id=clean(out?.messages?.[0]?.id,240);
  if(!id) throw new Error("provider_message_id_missing");
  return {provider_message_id:id,messages:out.messages||[]};
}
async function uploadMedia(env,request){
  const s=await status(env);
  if(!s.identity_verified||!s.phone_number_id) throw new Error("official_number_not_verified");
  const token=await accessToken(env);
  const bytes=await request.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>25*1024*1024) throw new Error("media_size_invalid");
  const mime=clean(request.headers.get("content-type")||"audio/mpeg",120);
  const filename=clean(request.headers.get("x-zevanory-filename")||"zevanory-media",160);
  const form=new FormData();
  form.append("messaging_product","whatsapp");
  form.append("file",new Blob([bytes],{type:mime}),filename);
  const r=await fetch("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(s.phone_number_id)+"/media",{method:"POST",headers:{authorization:"Bearer "+token},body:form,signal:AbortSignal.timeout(30000)});
  const out=await r.json().catch(()=>({}));
  if(!r.ok||!out.id) throw new Error("media_upload_failed");
  return {media_id:String(out.id)};
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/__zevanory/runtime"){
      const meta=env.CF_VERSION_METADATA||{};
      const wa=await status(env).catch(error=>({broker:true,configured:false,identity_verified:false,reason:clean(error?.message,180)}));
      return json({
        ok:true,
        service:"giro-whatsapp-bridge",
        zero_spend:true,
        runtime_sha:clean(meta.tag,120)||null,
        runtime_version:clean(meta.id,120)||null,
        runtime_created_at:clean(meta.timestamp,120)||null,
        canonical:"https://zevanory.api.br",
        legacy_route_bypass:0,
        whatsapp:{
          configured:wa.configured===true,
          official_e164:clean(wa.official_e164,32)||OFFICIAL_E164,
          official_number_found:wa.official_number_found===true,
          identity_verified:wa.identity_verified===true,
          app_secret_valid:wa.app_secret_valid===true,
          waba_present:Boolean(wa.waba_id),
          phone_number_id_present:Boolean(wa.phone_number_id),
          brand_name_verified:wa.brand_name_verified===true,
          name_status:clean(wa.name_status,80),
          code_verification_status:clean(wa.code_verification_status,80),
          permissions:{
            business_management:wa.permissions?.business_management===true,
            whatsapp_business_management:wa.permissions?.whatsapp_business_management===true,
            whatsapp_business_messaging:wa.permissions?.whatsapp_business_messaging===true
          },
          reason:clean(wa.reason,180)
        }
      });
    }
    if(!internal(request)){
      return json({ok:false,service:"giro-whatsapp-bridge",retired:true,canonical:"https://zevanory.api.br",old_number_active_route:false},410);
    }
    try{
      if(request.method==="GET"&&url.pathname==="/broker/status") return json(await status(env));
      if(request.method==="GET"&&url.pathname==="/broker/permissions"){
        const token=await accessToken(env); return json({permissions:await permissions(env,token)});
      }
      if(request.method==="POST"&&url.pathname==="/broker/oauth/callback"){
        const body=await request.json().catch(()=>({})); return json(await oauthCallback(env,body));
      }
      if(request.method==="POST"&&url.pathname==="/broker/request-code"){
        const body=await request.json().catch(()=>({})); return json(await requestCode(env,body));
      }
      if(request.method==="POST"&&url.pathname==="/broker/verify-code"){
        const body=await request.json().catch(()=>({})); return json(await verifyCode(env,body));
      }
      if(request.method==="POST"&&url.pathname==="/broker/verify-signature"){
        const body=await request.json().catch(()=>({})); return json({valid:await signatureValid(env,body.payload,body.signature)});
      }
      if(request.method==="POST"&&url.pathname==="/broker/verify-token"){
        const body=await request.json().catch(()=>({})); return json({valid:constantEqual(body.token,env.WHATSAPP_VERIFY_TOKEN)});
      }
      if(request.method==="POST"&&url.pathname==="/broker/send"){
        const body=await request.json().catch(()=>({})); return json(await sendMessage(env,body.message||{}));
      }
      if(request.method==="POST"&&url.pathname==="/broker/media") return json(await uploadMedia(env,request));
      return json({error:"not_found"},404);
    }catch(error){
      return json({error:"broker_operation_failed",reason:clean(error?.message,180)},400);
    }
  }
};
