const DEFAULT_APP_ID = "1071149631917061";
const DEFAULT_CONFIG_ID = "1447104223954128";
const GRAPH_VERSION = "v26.0";
const REDIRECT_URI = "https://zevanory.api.br/admin/whatsapp-onboard/callback";
const WEBHOOK_URI = "https://zevanory.api.br/api/webhooks/meta";
const OFFICIAL_E164 = "5588992545413";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function store(env){ return env.ZEVANORY_PRIVATE_ARTIFACTS || null; }
function b64url(bytes){ return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function fromB64url(value){
  const s=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
  const p=s+"=".repeat((4-s.length%4)%4);
  return Uint8Array.from(atob(p),c=>c.charCodeAt(0));
}
async function keyFor(env){
  const material=String(env.ELITE_INTERNAL_TOKEN||env.OPERATOR_TOKEN||env.ZEVANORY_ADMIN_PASSWORD||"");
  if(material.length<24) throw new Error("whatsapp_onboarding_master_key_missing");
  return crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",encoder.encode("zevanory:whatsapp:onboarding:v1:"+material)),{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function seal(value,env){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await keyFor(env);
  const data=encoder.encode(JSON.stringify(value));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,data));
  return b64url(iv)+"."+b64url(encrypted);
}
async function open(value,env){
  const [a,b]=String(value||"").split(".");
  if(!a||!b) throw new Error("whatsapp_onboarding_ciphertext_invalid");
  const key=await keyFor(env);
  const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64url(a)},key,fromB64url(b));
  return JSON.parse(decoder.decode(decrypted));
}
async function getRecord(env){
  const kv=store(env); if(!kv?.get) return null;
  const raw=await kv.get("whatsapp-onboarding/runtime");
  if(!raw) return null;
  return open(raw,env);
}
async function putRecord(env,value){
  const kv=store(env); if(!kv?.put) throw new Error("whatsapp_onboarding_storage_unavailable");
  await kv.put("whatsapp-onboarding/runtime",await seal(value,env));
}
async function putState(env,state){
  const kv=store(env);
  if(kv?.put){
    await kv.put("whatsapp-onboarding/state/"+state.id,"state-v1:"+JSON.stringify(state),{expirationTtl:900});
    return state.id;
  }
  return "sealed-v1."+await seal({nonce:state.id,created_at:state.created_at},env);
}
async function takeState(env,id){
  const value=String(id||"");
  if(value.startsWith("sealed-v1.")){
    const state=await open(value.slice("sealed-v1.".length),env);
    if(!state?.nonce||Date.now()-Number(state.created_at||0)>15*60*1000) throw new Error("whatsapp_onboarding_state_expired");
    return state;
  }
  const kv=store(env); if(!kv?.get) throw new Error("whatsapp_onboarding_storage_unavailable");
  const key="whatsapp-onboarding/state/"+value;
  const raw=await kv.get(key);
  if(!raw) throw new Error("whatsapp_onboarding_state_missing");
  await kv.delete?.(key).catch(()=>{});
  const state=String(raw).startsWith("state-v1:")?JSON.parse(String(raw).slice(9)):await open(raw,env);
  if(Date.now()-Number(state.created_at||0)>15*60*1000) throw new Error("whatsapp_onboarding_state_expired");
  return state;
}
function digits(v){ return String(v||"").replace(/\D/g,""); }
function safeText(v,max=500){ return String(v??"").trim().slice(0,max); }
function brokerBinding(env){ return env.WHATSAPP_BROKER || globalThis.__ZEVANORY_WHATSAPP_BROKER__ || null; }
async function brokerJson(env,path,{method="GET",body=null}={}){
  const broker=brokerBinding(env);
  if(!broker?.fetch) throw new Error("whatsapp_broker_unavailable");
  const init={method,headers:{"x-zevanory-internal":"service-binding","content-type":"application/json"}};
  if(body!==null) init.body=JSON.stringify(body);
  const r=await broker.fetch(new Request("https://whatsapp-broker.internal"+path,init));
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error("whatsapp_broker_http_"+r.status+"_"+safeText(j?.reason||j?.error||"provider_error",180));
  return j;
}
async function brokerStatus(env){
  try{return await brokerJson(env,"/broker/status");}
  catch(error){return {broker:false,configured:false,identity_verified:false,reason:safeText(error?.message,180)};}
}
function htmlEscape(v){ return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function responseHtml(body,status=200,extra={}){
  return new Response(body,{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","content-security-policy":"default-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://www.facebook.com; frame-ancestors 'none'",...extra}});
}
function responseJson(body,status=200){ return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}}); }
function embeddedSignupHtml(state){
  const nonce=htmlEscape(state);
  return responseHtml(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZEVANORY · WhatsApp</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0d10;color:#f5f7fa;max-width:760px;margin:auto;padding:32px 18px}main{background:#151a22;border:1px solid #303846;border-radius:18px;padding:26px}.btn{background:#1877f2;color:#fff;border:0;border-radius:10px;padding:13px 20px;font-weight:700;cursor:pointer}.msg{margin-top:16px;color:#ffd27a}</style></head><body><main><h1>Conectar WhatsApp oficial</h1><p>Número alvo: <strong>+55 88 99254-5413</strong></p><p>Use o fluxo oficial da Meta. Nenhum token será exibido nesta página.</p><button id="go" class="btn">Continuar com a Meta</button><p id="msg" class="msg"></p></main><script async defer crossorigin="anonymous" src="https://connect.facebook.net/pt_BR/sdk.js"></script><script>
let sessionInfo=null;
const state="${nonce}";
const msg=document.getElementById("msg");
window.fbAsyncInit=function(){FB.init({appId:"${DEFAULT_APP_ID}",autoLogAppEvents:true,xfbml:false,version:"${GRAPH_VERSION}"});};
window.addEventListener("message",(event)=>{if(!event.origin.endsWith("facebook.com"))return;try{const d=JSON.parse(event.data);if(d&&d.type==="WA_EMBEDDED_SIGNUP")sessionInfo=d;}catch{}});
async function finish(code){
  if(!sessionInfo||!sessionInfo.data){msg.textContent="A Meta não retornou os ativos do WhatsApp. Tente novamente.";return;}
  const d=sessionInfo.data;
  const body={state,code,waba_id:d.waba_id,phone_number_id:d.phone_number_id,business_id:d.business_id,flow_event:sessionInfo.event};
  const r=await fetch("/admin/whatsapp-onboard/embedded-complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(r.ok&&j.redirect){location.href=j.redirect;return;}
  msg.textContent=j.error||j.reason||"Falha ao concluir o onboarding.";
}
document.getElementById("go").onclick=function(){
  msg.textContent="Abrindo autorização oficial da Meta...";
  FB.login((response)=>{if(response.authResponse&&response.authResponse.code){finish(response.authResponse.code);}else{msg.textContent="Autorização não concluída.";}},
  {config_id:"${DEFAULT_CONFIG_ID}",response_type:"code",override_default_response_type:true,extras:{setup:{}}});
};
</script></body></html>`,200,{"content-security-policy":"default-src 'self' https://connect.facebook.net https://www.facebook.com; script-src 'self' 'unsafe-inline' https://connect.facebook.net; connect-src 'self' https://www.facebook.com https://graph.facebook.com; frame-src https://www.facebook.com; style-src 'unsafe-inline'; frame-ancestors 'none'"});
}
async function graphJson(url,{token,method="GET",body=null,headers={}}={}){
  const h={...headers};
  if(token) h.authorization="Bearer "+token;
  let payload=body;
  if(body && !(body instanceof URLSearchParams) && typeof body==="object"){
    h["content-type"]="application/json"; payload=JSON.stringify(body);
  }
  const r=await fetch(url,{method,headers:h,body:payload,signal:AbortSignal.timeout(20000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) {
    const code=safeText(j?.error?.code||r.status,40), msg=safeText(j?.error?.message||"provider_error",240);
    throw new Error("meta_http_"+r.status+"_"+code+"_"+msg.replace(/\s+/g,"_"));
  }
  return j;
}
async function exchangeCode({code,app_id,app_secret}){
  const u=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token");
  u.searchParams.set("client_id",app_id);
  u.searchParams.set("redirect_uri",REDIRECT_URI);
  u.searchParams.set("client_secret",app_secret);
  u.searchParams.set("code",code);
  const short=await graphJson(u.toString());
  if(!short.access_token) throw new Error("meta_access_token_missing_after_exchange");
  const x=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token");
  x.searchParams.set("grant_type","fb_exchange_token");
  x.searchParams.set("client_id",app_id);
  x.searchParams.set("client_secret",app_secret);
  x.searchParams.set("fb_exchange_token",short.access_token);
  const long=await graphJson(x.toString());
  return String(long.access_token||short.access_token);
}
async function appAccessToken(app_id,app_secret){
  const u=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token");
  u.searchParams.set("client_id",app_id);
  u.searchParams.set("client_secret",app_secret);
  u.searchParams.set("grant_type","client_credentials");
  const j=await graphJson(u.toString());
  return String(j.access_token||"");
}
async function discoverOfficialNumber(token){
  const businesses=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/me/businesses?fields=id,name&limit=100",{token});
  for(const business of businesses.data||[]){
    let wab;
    try {
      wab=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(business.id)+"/owned_whatsapp_business_accounts?fields=id,name,currency,timezone_id&limit=100",{token});
    } catch { continue; }
    for(const waba of wab.data||[]){
      let phones;
      try {
        phones=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(waba.id)+"/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,new_name_status&limit=100",{token});
      } catch { continue; }
      for(const phone of phones.data||[]){
        if(digits(phone.display_phone_number)===OFFICIAL_E164){
          return {business,waba,phone};
        }
      }
    }
  }
  return null;
}
async function configureAppWebhook({app_id,app_secret,verify_token}){
  const token=await appAccessToken(app_id,app_secret);
  if(!token) throw new Error("meta_app_access_token_missing");
  const form=new URLSearchParams({
    object:"whatsapp_business_account",
    callback_url:WEBHOOK_URI,
    verify_token,
    fields:"messages",
    include_values:"true"
  });
  const j=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(app_id)+"/subscriptions",{token,method:"POST",body:form,headers:{"content-type":"application/x-www-form-urlencoded"}});
  return j?.success===true;
}
async function subscribeWaba({waba_id,token}){
  const j=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(waba_id)+"/subscribed_apps",{token,method:"POST",body:{subscribed_fields:["messages"]}});
  return j?.success===true;
}
async function registerPhone({phone_id,token,pin}){
  try {
    const j=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(phone_id)+"/register",{token,method:"POST",body:{messaging_product:"whatsapp",pin}});
    return {ok:j?.success===true,already_registered:false,error:null};
  } catch(error) {
    const msg=String(error?.message||"");
    if(/already|registered/i.test(msg)) return {ok:true,already_registered:true,error:null};
    return {ok:false,already_registered:false,error:safeText(msg,240)};
  }
}
async function verifyRuntime(record){
  if(!record?.access_token||!record?.phone_number_id) return {verified:false,reason:"credentials_missing"};
  try {
    const fields="id,display_phone_number,verified_name,name_status,new_name_status,quality_rating,code_verification_status";
    const p=await graphJson("https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(record.phone_number_id)+"?fields="+encodeURIComponent(fields),{token:record.access_token});
    const number_ok=String(p.id||"")===String(record.phone_number_id)&&digits(p.display_phone_number)===OFFICIAL_E164;
    const brand_ok=String(p.verified_name||"").trim().toUpperCase()==="ZEVANORY";
    const name_ok=["APPROVED","AVAILABLE_WITHOUT_REVIEW"].includes(String(p.name_status||"").toUpperCase());
    return {verified:number_ok&&brand_ok&&name_ok,number_ok,brand_ok,name_ok,verified_name:safeText(p.verified_name),name_status:safeText(p.name_status),quality_rating:safeText(p.quality_rating),code_verification_status:safeText(p.code_verification_status)};
  } catch(error){ return {verified:false,reason:safeText(error?.message,240)}; }
}
function dashboard(record,live,message=""){
  const ready=Boolean(record?.app_secret);
  const connected=Boolean(record?.access_token&&record?.phone_number_id&&record?.waba_id);
  const verified=Boolean(live?.verified);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZEVANORY · WhatsApp Onboarding</title><style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0d10;color:#f5f7fa;max-width:820px;margin:auto;padding:28px 18px}main{background:#151a22;border:1px solid #303846;border-radius:18px;padding:24px}.row{padding:12px 0;border-bottom:1px solid #2a313d}.ok{color:#85e69d}.warn{color:#ffd27a}.bad{color:#ff9c9c}input{width:100%;box-sizing:border-box;background:#0d1117;color:#fff;border:1px solid #394453;border-radius:10px;padding:12px;margin:8px 0}button,a.btn{display:inline-block;background:#fff;color:#111;border:0;border-radius:10px;padding:12px 18px;font-weight:700;text-decoration:none;cursor:pointer;margin-top:10px}small{color:#b6bdc8}code{word-break:break-all}</style></head><body><main>
  <h1>Conexão oficial WhatsApp · ZEVANORY</h1><p>Número alvo: <strong>+55 88 99254-5413</strong>. Segredos são gravados criptografados e nunca exibidos novamente.</p>
  ${message?`<p class="warn">${htmlEscape(message)}</p>`:""}
  <div class="row">App Secret: <b class="${ready?"ok":"bad"}">${ready?"armazenado":"ausente"}</b></div>
  <div class="row">Cloud API: <b class="${connected?"ok":"warn"}">${connected?"credencial descoberta":"aguardando autorização"}</b></div>
  <div class="row">Identidade do número: <b class="${verified?"ok":"warn"}">${verified?"verificada ao vivo":"ainda não verificada"}</b></div>
  <div class="row">WABA: <code>${connected?htmlEscape(record.waba_id):"—"}</code></div>
  <div class="row">Phone Number ID: <code>${connected?htmlEscape(record.phone_number_id):"—"}</code></div>
  ${!ready?`<form method="post" action="/admin/whatsapp-onboard/bootstrap"><label>Meta App Secret</label><input type="password" name="app_secret" minlength="16" required autocomplete="off"><label>App ID</label><input name="app_id" value="${DEFAULT_APP_ID}" required><label>Configuration ID</label><input name="config_id" value="${DEFAULT_CONFIG_ID}" required><button type="submit">Salvar com criptografia</button></form>`:""}
  ${ready&&!verified?`<a class="btn" href="/admin/whatsapp-onboard/start">Autorizar e localizar o número na Meta</a>`:""}
  ${verified?`<p class="ok"><strong>Identidade Meta confirmada.</strong> O runtime pode usar as credenciais privadas armazenadas.</p>`:""}
  <p><small>Callback: ${REDIRECT_URI}<br>Webhook: ${WEBHOOK_URI}</small></p>
  </main></body></html>`;
}
async function parseForm(request){
  const type=String(request.headers.get("content-type")||"");
  if(type.includes("application/x-www-form-urlencoded")){
    const f=new URLSearchParams(await request.text()); return Object.fromEntries(f.entries());
  }
  return request.json().catch(()=>({}));
}
export async function loadWhatsappRuntimeCredentials(env={}){
  try {
    const r=await getRecord(env);
    if(!r?.access_token||!r?.phone_number_id||!r?.app_secret||!r?.verify_token) return null;
    return Object.freeze({
      access_token:r.access_token,
      phone_number_id:r.phone_number_id,
      waba_id:r.waba_id||"",
      app_secret:r.app_secret,
      verify_token:r.verify_token,
      graph_version:r.graph_version||GRAPH_VERSION,
      identity_verified:r.identity_verified===true,
      official_e164:OFFICIAL_E164
    });
  } catch { return null; }
}
export async function whatsappOnboardingStatus(env={}) {
  const broker=await brokerStatus(env);
  if(broker?.broker===true) return Object.freeze({...broker,official_number:OFFICIAL_E164});
  const record=await getRecord(env).catch(()=>null);
  const live=record?await verifyRuntime(record):{verified:false,reason:"not_configured"};
  return Object.freeze({
    configured:Boolean(record?.access_token&&record?.phone_number_id&&record?.app_secret&&record?.verify_token),
    identity_verified:Boolean(live.verified),
    webhook_configured:Boolean(record?.webhook_configured),
    waba_subscribed:Boolean(record?.waba_subscribed),
    phone_registration_ok:Boolean(record?.phone_registration_ok),
    official_number:OFFICIAL_E164,
    waba_id:record?.waba_id||null,
    phone_number_id:record?.phone_number_id||null,
    live
  });
}

export async function handleWhatsappOnboarding(request,env={}){
  const url=new URL(request.url);
  let record=await getRecord(env).catch(()=>null);
  const brokerState=await brokerStatus(env);
  if(url.pathname==="/admin/whatsapp-onboard"&&request.method==="GET"){
    const live=brokerState?.broker===true?{
      verified:Boolean(brokerState.identity_verified),
      verified_name:safeText(brokerState.verified_name),
      name_status:safeText(brokerState.name_status),
      code_verification_status:safeText(brokerState.code_verification_status)
    }:record?await verifyRuntime(record):{verified:false};
    const viewRecord=brokerState?.broker===true?{
      app_secret:Boolean(brokerState.app_secret_valid),
      access_token:Boolean(brokerState.configured),
      phone_number_id:brokerState.phone_number_id||"",
      waba_id:brokerState.waba_id||""
    }:record;
    if(record&&brokerState?.broker!==true&&Boolean(record.identity_verified)!==Boolean(live.verified)){record={...record,identity_verified:Boolean(live.verified),updated_at:new Date().toISOString()}; await putRecord(env,record);}
    return responseHtml(dashboard(viewRecord,live,url.searchParams.get("message")||""));
  }
  if(url.pathname==="/admin/whatsapp-onboard/bootstrap"&&request.method==="POST"){
    const body=await parseForm(request);
    const app_secret=safeText(body.app_secret,4000), app_id=safeText(body.app_id||DEFAULT_APP_ID,64), config_id=safeText(body.config_id||DEFAULT_CONFIG_ID,64);
    if(app_secret.length<16||!/^\d{6,30}$/.test(app_id)||!/^\d{6,30}$/.test(config_id)) return responseJson({error:"meta_bootstrap_invalid"},400);
    record={...(record||{}),app_id,config_id,app_secret,graph_version:GRAPH_VERSION,updated_at:new Date().toISOString()};
    await putRecord(env,record);
    return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard",303);
  }
  if(url.pathname==="/admin/whatsapp-onboard/start"&&request.method==="GET"){
    if(brokerBinding(env)){
      const started=await brokerJson(env,"/broker/oauth/start",{method:"POST",body:{}});
      const state=safeText(started.state,300);
      if(!state) throw new Error("whatsapp_broker_oauth_state_missing");
      return embeddedSignupHtml(state);
    }
    if(!record?.app_secret) return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard?message=Provedor%20Meta%20indispon%C3%ADvel",303);
    const state={id:b64url(crypto.getRandomValues(new Uint8Array(24))),created_at:Date.now()};
    const stateToken=await putState(env,state);
    const u=new URL("https://www.facebook.com/"+GRAPH_VERSION+"/dialog/oauth");
    u.searchParams.set("client_id",record?.app_id||DEFAULT_APP_ID);
    u.searchParams.set("redirect_uri",REDIRECT_URI);
    u.searchParams.set("state",stateToken);
    u.searchParams.set("response_type","code");
    u.searchParams.set("config_id",record?.config_id||DEFAULT_CONFIG_ID);
    u.searchParams.set("override_default_response_type","true");
    u.searchParams.set("scope",["business_management","whatsapp_business_management","whatsapp_business_messaging"].join(","));
    return Response.redirect(u.toString(),302);
  }
  if(url.pathname==="/admin/whatsapp-onboard/embedded-complete"&&request.method==="POST"){
    if(!brokerBinding(env)) return responseJson({error:"whatsapp_broker_unavailable"},503);
    const body=await request.json().catch(()=>({}));
    const stateId=safeText(body.state,300),code=safeText(body.code,5000);
    const wabaId=digits(body.waba_id),phoneId=digits(body.phone_number_id),businessId=digits(body.business_id),flowEvent=safeText(body.flow_event,80);
    if(!stateId||!code||!wabaId||!phoneId) return responseJson({error:"embedded_payload_invalid"},400);
    try{
      await brokerJson(env,"/broker/oauth/consume-state",{method:"POST",body:{state:stateId}});
      const outcome=await brokerJson(env,"/broker/oauth/callback",{method:"POST",body:{code,waba_id:wabaId,phone_number_id:phoneId,business_id:businessId,flow_event:flowEvent}});
      const message=outcome.identity_verified
        ?"Número oficial localizado, registrado e identidade Meta verificada."
        :outcome.official_number_found
          ?"Número oficial localizado. A identidade ainda precisa concluir os critérios Meta."
          :"Onboarding concluído sem correspondência do número oficial.";
      return responseJson({ok:true,redirect:"https://zevanory.api.br/admin/whatsapp-onboard?message="+encodeURIComponent(message),outcome:{official_number_found:Boolean(outcome.official_number_found),identity_verified:Boolean(outcome.identity_verified),webhook_configured:Boolean(outcome.webhook_configured),waba_subscribed:Boolean(outcome.waba_subscribed)}});
    }catch(error){
      return responseJson({error:"embedded_completion_failed",reason:safeText(error?.message,180)},400);
    }
  }
  if(url.pathname==="/admin/whatsapp-onboard/callback"&&request.method==="GET"){
    const error=safeText(url.searchParams.get("error"),100), code=safeText(url.searchParams.get("code"),4000), stateId=safeText(url.searchParams.get("state"),200);
    if(error) return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard?message="+encodeURIComponent("Meta recusou a autorização: "+error),303);
    if(!code||!stateId||(!brokerBinding(env)&&!record?.app_secret)) return responseJson({error:"meta_callback_invalid"},400);
    if(brokerBinding(env)){
      try {
        await brokerJson(env,"/broker/oauth/consume-state",{method:"POST",body:{state:stateId}});
        const outcome=await brokerJson(env,"/broker/oauth/callback",{method:"POST",body:{code,redirect_uri:REDIRECT_URI,official_e164:OFFICIAL_E164}});
        const message=outcome.identity_verified
          ?"Número oficial localizado, registrado e identidade Meta verificada."
          :outcome.official_number_found
            ?"Número oficial localizado. A Meta ainda exige conclusão da verificação do número."
            :"Autorização concluída. A Meta ainda exige adicionar e verificar o número +55 88 99254-5413 na conta WhatsApp Business.";
        return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard?message="+encodeURIComponent(message),303);
      } catch(error) {
        const reason=safeText(error?.message||"whatsapp_oauth_callback_failed",180);
        return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard?message="+encodeURIComponent("Falha segura no callback Meta: "+reason+". Reinicie pelo launcher oficial."),303);
      }
    }
    await takeState(env,stateId);
    const access_token=await exchangeCode({code,app_id:record.app_id||DEFAULT_APP_ID,app_secret:record.app_secret});
    const found=await discoverOfficialNumber(access_token);
    if(!found) {
      record={...record,access_token,identity_verified:false,last_error:"official_number_not_found_in_authorized_business",updated_at:new Date().toISOString()};
      await putRecord(env,record);
      return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard?message="+encodeURIComponent("Autorização concluída, mas o número +55 88 99254-5413 ainda não aparece em uma WABA autorizada. Adicione/verifique o número no fluxo oficial da Meta e repita a autorização."),303);
    }
    const verify_token=b64url(crypto.getRandomValues(new Uint8Array(32)));
    const pin=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
    let webhook_configured=false,waba_subscribed=false;
    try { webhook_configured=await configureAppWebhook({app_id:record.app_id||DEFAULT_APP_ID,app_secret:record.app_secret,verify_token}); } catch(error){ record={...record,webhook_error:safeText(error?.message,240)}; }
    try { waba_subscribed=await subscribeWaba({waba_id:String(found.waba.id),token:access_token}); } catch(error){ record={...record,waba_subscribe_error:safeText(error?.message,240)}; }
    const registration=await registerPhone({phone_id:String(found.phone.id),token:access_token,pin});
    record={...record,access_token,waba_id:String(found.waba.id),phone_number_id:String(found.phone.id),verify_token,two_step_pin:pin,webhook_configured,waba_subscribed,phone_registration_ok:registration.ok,phone_registration_already:registration.already_registered,phone_registration_error:registration.error||null,display_phone_number:digits(found.phone.display_phone_number),verified_name:safeText(found.phone.verified_name),identity_verified:false,updated_at:new Date().toISOString()};
    const live=await verifyRuntime(record);
    record={...record,identity_verified:Boolean(live.verified),identity_live:live};
    await putRecord(env,record);
    const message=live.verified?"Número oficial localizado e identidade Meta verificada.":"Credenciais armazenadas; a identidade do número ainda não passou integralmente na verificação ao vivo.";
    return Response.redirect("https://zevanory.api.br/admin/whatsapp-onboard?message="+encodeURIComponent(message),303);
  }
  if(url.pathname==="/api/admin/whatsapp-onboard/status"&&request.method==="GET"){
    return responseJson(await whatsappOnboardingStatus(env));
  }
  return null;
}
