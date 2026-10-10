// Opt-in, idempotent profile branding. Never mark profile_updated before
// the provider confirms a write and a subsequent authenticated readback.
import { validateBrandProfileAsset } from "./brand-kit.mjs";
import { emitActivity } from "./activity-ledger.mjs";
import { resolveChannelCredentials } from "./multichannel-autonomy.mjs";

export const OFFICIAL_SOCIAL_PROFILE = Object.freeze({
  bluesky: Object.freeze({
    displayName:"ZEVANORY",
    description:"IA na prática para pequenos negócios. Criada por Renan Bitu, Várzea Alegre/CE. https://vendas.zevanory.api.br/?utm_source=bluesky&utm_medium=profile",
  }),
  telegram: Object.freeze({
    title:"ZEVANORY",
    description:"IA na prática para pequenos negócios. Criada por Renan Bitu, Várzea Alegre/CE. https://vendas.zevanory.api.br/?utm_source=telegram&utm_medium=profile",
  }),
});
export const BRAND_PROFILE_STATE_KEY="zpc:brand:profiles:v1";
const URL="https://zevanory.api.br/brand/export/";
export const MANUAL_PROFILE_ACTIONS=Object.freeze([
 {channel:"instagram",status:"depende_do_dono",profile_url:"https://www.instagram.com/zevanory_/",edit_url:"https://www.instagram.com/accounts/edit/",assets:["avatar-800.png"]},
 {channel:"facebook",status:"depende_do_dono",profile_url:"https://www.facebook.com/profile.php?id=1249902628211703",edit_url:"https://www.facebook.com/",assets:["avatar-800.png","banner-facebook.png"]},
 {channel:"youtube",status:"depende_do_dono",profile_url:"https://www.youtube.com/@zevanory",edit_url:"https://studio.youtube.com/",assets:["avatar-800.png","banner-youtube.png"]},
 {channel:"pinterest",status:"depende_do_dono",profile_url:null,edit_url:"https://www.pinterest.com/settings/",assets:["avatar-800.png"]},
 {channel:"whatsapp",status:"depende_do_dono",profile_url:null,edit_url:null,instructions:"WhatsApp Business > Ferramentas comerciais > Perfil comercial > Foto",assets:["avatar-800.png"]},
 {channel:"google",status:"depende_do_dono",profile_url:null,edit_url:"https://business.google.com/",assets:["avatar-800.png"]}
]);

const read=async (kv,key,fallback=null)=>{try{return JSON.parse(String(await kv.get(key)||"null"))??fallback;}catch{return fallback;}};
// A Worker's subrequest to its own zone does not re-enter this Worker, so
// /brand/export/* (served by this Worker from ASSETS) is unreachable via fetch()
// from inside it (live code: brand_image_fetch_unverified). Read the same
// SHA-pinned bytes straight from the ASSETS binding; the validator still checks
// filename, role, PNG dimensions and the approved SHA-256, so trust is unchanged.
function brandAssetFetch(env,fetchImpl){
 const assets=env?.ASSETS;
 if(!assets?.fetch)return fetchImpl;
 return (url,init={})=>String(url).startsWith(URL)?assets.fetch(new Request(String(url),{method:"GET"})):fetchImpl(url,init);
}
async function verifiedImage(channel,name,fetchImpl,env){
 return (await validateBrandProfileAsset({channel,url:URL+name,fetchImpl:brandAssetFetch(env,fetchImpl),includeBytes:true})).bytes;
}
const xrpc="https://bsky.social/xrpc/";
async function json(fetchImpl,url,options={}) {
 const res=await fetchImpl(url,{...options,signal:AbortSignal.timeout(15000)});
 const body=await res.json().catch(()=>({}));
 if(!res.ok){
  if(url.startsWith("https://api.telegram.org/")&&/not enough rights|chat_admin_required|not enough permission/i.test(String(body.description||"")))throw new Error("telegram_missing_can_change_info");
  throw new Error("profile_provider_http_"+res.status);
 }
 return body;
}
export async function updateBlueskyProfile(env,fetchImpl=fetch){
 env=resolveChannelCredentials(env);
 if(!env.BLUESKY_HANDLE||!env.BLUESKY_APP_PASSWORD)return {status:"depende_do_dono",code:"bluesky_credentials"};
 const [avatar,banner]=await Promise.all([verifiedImage("bluesky","avatar-800.png",fetchImpl,env),verifiedImage("bluesky","banner-bluesky.png",fetchImpl,env)]);
 const session=await json(fetchImpl,xrpc+"com.atproto.server.createSession",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identifier:env.BLUESKY_HANDLE,password:env.BLUESKY_APP_PASSWORD})});
 if(!session.did||!session.accessJwt)throw new Error("profile_session_invalid");
 const bearer={authorization:"Bearer "+session.accessJwt};
 const target=xrpc+"com.atproto.repo.getRecord?repo="+encodeURIComponent(session.did)+"&collection=app.bsky.actor.profile&rkey=self";
 let prior=null,cid;
 const current=await fetchImpl(target,{headers:bearer,signal:AbortSignal.timeout(15000)});
 if(current.status===200){const data=await current.json();prior=data.value;cid=data.cid;}
 else if(current.status!==404)throw new Error("profile_read_failed");
 async function upload(bytes){
   const data=await json(fetchImpl,xrpc+"com.atproto.repo.uploadBlob",{method:"POST",headers:{...bearer,"content-type":"image/png"},body:bytes});
   if(!data.blob?.ref?.$link)throw new Error("profile_blob_unverified");
   return data.blob;
 }
 const image=await upload(avatar),cover=await upload(banner);
 const record={...(prior||{}),$type:"app.bsky.actor.profile",createdAt:prior?.createdAt||new Date().toISOString(),...OFFICIAL_SOCIAL_PROFILE.bluesky,avatar:image,banner:cover};
 const data=await json(fetchImpl,xrpc+"com.atproto.repo.putRecord",{method:"POST",headers:{...bearer,"content-type":"application/json"},body:JSON.stringify({repo:session.did,collection:"app.bsky.actor.profile",rkey:"self",record,...(cid?{swapRecord:cid}:{})})});
 if(!data.uri||!data.cid)throw new Error("profile_write_unverified");
 const after=await json(fetchImpl,target,{headers:bearer});
 if(after.value?.avatar?.ref?.$link!==image.ref.$link||after.value?.banner?.ref?.$link!==cover.ref.$link||after.value?.displayName!==OFFICIAL_SOCIAL_PROFILE.bluesky.displayName||after.value?.description!==OFFICIAL_SOCIAL_PROFILE.bluesky.description)throw new Error("profile_readback_mismatch");
 return {status:"atualizado",channel:"bluesky",profile_url:"https://bsky.app/profile/"+encodeURIComponent(session.did),at:new Date().toISOString(),provider_record:data.uri};
}
export async function updateTelegramChannelPhoto(env,fetchImpl=fetch){
 env=resolveChannelCredentials(env);
 if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHANNEL_ID)return {status:"depende_do_dono",code:"telegram_credentials"};
 const bytes=await verifiedImage("telegram","avatar-800.png",fetchImpl,env);
 const endpoint="https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/";
 const chat=env.TELEGRAM_CHANNEL_ID;
 const before=await json(fetchImpl,endpoint+"getChat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat})});
 if(!before.ok)throw new Error("telegram_chat_read_failed");
 const official=OFFICIAL_SOCIAL_PROFILE.telegram;
 if(before.result?.title!==official.title){
   const titleOut=await json(fetchImpl,endpoint+"setChatTitle",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,title:official.title})});
   if(titleOut.ok!==true||titleOut.result!==true)throw new Error("telegram_title_update_unverified");
 }
 if(before.result?.description!==official.description){
   const descOut=await json(fetchImpl,endpoint+"setChatDescription",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,description:official.description})});
   if(descOut.ok!==true||descOut.result!==true)throw new Error("telegram_description_update_unverified");
 }
 const form=new FormData();form.append("chat_id",chat);form.append("photo",new Blob([bytes],{type:"image/png"}),"zevanory-avatar.png");
 const response=await json(fetchImpl,endpoint+"setChatPhoto",{method:"POST",body:form});
 if(response.ok!==true||response.result!==true)throw new Error("telegram_profile_update_unverified");
 const after=await json(fetchImpl,endpoint+"getChat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat})});
 if(!after.ok || after.result?.title!==official.title || after.result?.description!==official.description || !after.result?.photo?.big_file_id || before.result?.photo?.big_file_id===after.result?.photo?.big_file_id)
   throw new Error("telegram_profile_readback_unverified");
 return {status:"atualizado",channel:"telegram",profile_url:chat.startsWith("@")?"https://t.me/"+chat.slice(1):null,at:new Date().toISOString(),photo_file_id:after.result.photo.big_file_id};
}
// A historical successful receipt is not proof that a human has not subsequently
// edited the provider profile. GET readback first; mutate only on confirmed drift.
export async function liveBrandProfileConforms(channel,env={},fetchImpl=fetch,previous={}){
 const cfg=resolveChannelCredentials(env);
 if(channel==="bluesky"){
  if(!cfg.BLUESKY_HANDLE)return false;
  const url="https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor="+encodeURIComponent(cfg.BLUESKY_HANDLE);
  const response=await fetchImpl(url,{method:"GET",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error("bluesky_readback_unavailable");
  const profile=await response.json();
  return profile?.displayName===OFFICIAL_SOCIAL_PROFILE.bluesky.displayName &&
   profile?.description===OFFICIAL_SOCIAL_PROFILE.bluesky.description &&
   /^https:\/\//.test(String(profile?.avatar||"")) &&
   /^https:\/\//.test(String(profile?.banner||""));
 }
 if(channel==="telegram"){
  if(!cfg.TELEGRAM_BOT_TOKEN||!cfg.TELEGRAM_CHANNEL_ID)return false;
  const reply=await json(fetchImpl,"https://api.telegram.org/bot"+cfg.TELEGRAM_BOT_TOKEN+"/getChat",{
   method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:cfg.TELEGRAM_CHANNEL_ID})
  });
  const chat=reply.result||{},photo=chat.photo?.big_file_id||null;
  return reply.ok===true && chat.title===OFFICIAL_SOCIAL_PROFILE.telegram.title &&
   chat.description===OFFICIAL_SOCIAL_PROFILE.telegram.description && Boolean(photo) &&
   (!previous.photo_file_id || previous.photo_file_id===photo);
 }
 return false;
}

export async function syncBrandProfiles(env={},fetchImpl=fetch){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put)return {status:"bloqueado",code:"kv_unavailable"};
 const state=await read(kv,BRAND_PROFILE_STATE_KEY,{});
 const tasks=[["bluesky",updateBlueskyProfile],["telegram",updateTelegramChannelPhoto]];
 const outcomes=[];
 for(const [channel,fn] of tasks){
   // v2 invalidates receipts made before the official name/bio readback contract.
   const key="zpc:brand:profile:"+channel+":v2";
   const previous=await read(kv,key);
   // A pending marker is not a receipt: failed provider updates must retry on the next hourly cycle.
   // Only a successfully verified v2 record can suppress a duplicate profile mutation.
   const signedReceipt=previous?.status==="atualizado" && Boolean(previous?.at) &&
     (channel==="telegram" || Boolean(previous?.provider_record));
   if(signedReceipt){
     try{
       if(await liveBrandProfileConforms(channel,env,fetchImpl,previous)){
         outcomes.push(previous);continue;
       }
     }catch{
       outcomes.push({channel,status:"pendente_conciliacao",code:"provider_readback_unavailable"});
       continue; // No unverified duplicate writes on provider outage.
     }
   }
   let result;
   const resolved=resolveChannelCredentials(env);
   if(channel==="bluesky"&&(!resolved.BLUESKY_HANDLE||!resolved.BLUESKY_APP_PASSWORD) ||
      channel==="telegram"&&(!resolved.TELEGRAM_BOT_TOKEN||!resolved.TELEGRAM_CHANNEL_ID)){
      result={status:"depende_do_dono",channel,code:"credentials_missing"};
      outcomes.push(result);continue;
   }
   await kv.put(key,JSON.stringify({channel,status:"pendente_conciliacao"}),{expirationTtl:30*86400});
   try{
     result=await fn(env,fetchImpl);
     if(result.status==="atualizado"){
       await emitActivity(env,{type:"profile_updated",channel,status:"updated",ref:"brand-profile:"+channel+":v2",link:result.profile_url}).catch(()=>null);
       await kv.put(key,JSON.stringify(result),{expirationTtl:180*86400});
     }
   }catch(error){
     // Only fixed internal codes (never provider bodies, tokens or URLs).
     const raw=String(error?.message||"");
     result={channel,status:"pendente_conciliacao",code:/^[a-z][a-z0-9_]{2,63}$/.test(raw)?raw:"provider_or_readback_unverified",at:new Date().toISOString()};
   }
   outcomes.push(result);
 }
 const snapshot={schema:"zevanory.brand-profiles.v1",at:new Date().toISOString(),profiles:[...outcomes,...MANUAL_PROFILE_ACTIONS]};
 await kv.put(BRAND_PROFILE_STATE_KEY,JSON.stringify({...state,...snapshot}),{expirationTtl:30*86400});
 return snapshot;
}
export async function brandProfileSnapshot(env={}){
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get)return {schema:"zevanory.brand-profiles.v1",status:"indisponivel"};
 return await read(kv,BRAND_PROFILE_STATE_KEY,{schema:"zevanory.brand-profiles.v1",status:"sem_dados",profiles:[...MANUAL_PROFILE_ACTIONS]});
}

// Public, sanitized view for the read-only conformity matrix: no credentials,
// no provider payloads; Bluesky handle is public by definition.
export async function publicBrandProfileStatus(env={}){
 const snap=await brandProfileSnapshot(env);
 const cfg=resolveChannelCredentials(env);
 const profiles=(snap.profiles||[]).filter(p=>p&&["bluesky","telegram"].includes(p.channel))
   .map(p=>({channel:p.channel,status:String(p.status||""),code:p.code?String(p.code):null,at:p.at||null}));
 return {schema:"zevanory.brand-profiles.public.v1",at:snap.at||null,bluesky_handle:cfg.BLUESKY_HANDLE?String(cfg.BLUESKY_HANDLE).replace(/^@/,""):null,profiles};
}
