// PIN-gated bridge issues short-lived HMAC tickets. No owner credentials or tokens in URLs.
const enc=new TextEncoder(),host="https://zevanory.api.br/api/owner/oauth/",panel="https://controle.zevanory.api.br/";
export const OAUTH_PROVIDERS=Object.freeze({
 youtube:{auth:"https://accounts.google.com/o/oauth2/v2/auth",token:"https://oauth2.googleapis.com/token",scope:"https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube",pkce:true},
 pinterest:{auth:"https://www.pinterest.com/oauth/",token:"https://api.pinterest.com/v5/oauth/token",scope:"boards:read pins:write pins:read",pkce:false}
});
const result=(data,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"}});
const b64=buffer=>btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const rand=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const sha=async s=>b64(await crypto.subtle.digest("SHA-256",enc.encode(s)));
const connKey=c=>"zpc:owner:oauth:connection:"+c+":v1";
const stateKey=s=>"zpc:owner:oauth:state:"+s;
const ticketKey=s=>"zpc:owner:oauth:ticket:"+s;
const callback=c=>host+c+"/callback";
const cookieName=c=>"zpc_oauth_state_"+c;
const cookie=(c,s,age)=>cookieName(c)+"="+encodeURIComponent(s)+"; Secure; HttpOnly; SameSite=Lax; Path="+new URL(callback(c)).pathname+"; Max-Age="+age;
const eq=(a,b)=>{const x=enc.encode(String(a)),y=enc.encode(String(b));let n=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)n|=(x[i]||0)^(y[i]||0);return n===0;};
const settings=(env,c)=>{
 let bundle={};try{bundle=JSON.parse(String(env.CHANNEL_CREDENTIALS_JSON||"{}"));}catch{}
 const prefix=c==="youtube"?"YOUTUBE":"PINTEREST";
 return {id:String(env[prefix+"_CLIENT_ID"]||bundle[prefix+"_CLIENT_ID"]||""),secret:String(env[prefix+"_CLIENT_SECRET"]||bundle[prefix+"_CLIENT_SECRET"]||"")};
};
async function mac(secret,message){
 const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return b64(await crypto.subtle.sign("HMAC",key,enc.encode(message)));
}
async function cipherKey(env){
 const secret=String(env.OWNER_OAUTH_ENCRYPTION_KEY||"");
 if(secret.length<32)throw Error("oauth_encryption_not_configured");
 const key=await crypto.subtle.digest("SHA-256",enc.encode(secret));
 return crypto.subtle.importKey("raw",key,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function seal(env,s){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const bytes=await crypto.subtle.encrypt({name:"AES-GCM",iv},await cipherKey(env),enc.encode(s));
 return {alg:"AES-256-GCM",iv:b64(iv),ciphertext:b64(bytes)};
}

const from64=value=>{
 if(!/^[a-zA-Z0-9_-]+$/.test(String(value||"")))throw Error("invalid_cipher_blob");
 const padded=value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"=");
 return Uint8Array.from(atob(padded),x=>x.charCodeAt(0));
};
export async function openOAuthRefresh(env,blob){
 if(blob?.alg!=="AES-256-GCM"||typeof blob.iv!=="string"||typeof blob.ciphertext!=="string")
   throw Error("oauth_cipher_invalid");
 const iv=from64(blob.iv),data=from64(blob.ciphertext);
 if(iv.length!==12||data.length<17)throw Error("oauth_cipher_invalid");
 const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv},await cipherKey(env),data);
 const refresh=new TextDecoder("utf-8",{fatal:true}).decode(plaintext);
 if(!refresh||refresh.length>4096)throw Error("oauth_refresh_invalid");
 return refresh;
}
export async function resolveOwnerPublisherToken(env,channel,fetchImpl=fetch){
 if(!Object.hasOwn(OAUTH_PROVIDERS,channel))throw Error("oauth_channel_invalid");
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get)return null; // Legacy credentials may still be used when not connected.
 let stored;try{stored=JSON.parse(String(await kv.get(connKey(channel))||"null"));}catch{throw Error("oauth_connection_invalid");}
 if(!stored)return null;
 if(stored.schema!=="zpc.owner.oauth.v1"||stored.channel!==channel||!stored.encryptedRefresh)throw Error("oauth_connection_invalid");
 const credentials=settings(env,channel);
 if(!credentials.id||!credentials.secret)throw Error("oauth_client_missing");
 const refresh=await openOAuthRefresh(env,stored.encryptedRefresh);
 const provider=OAUTH_PROVIDERS[channel];
 const headers={"content-type":"application/x-www-form-urlencoded"};
 const body={grant_type:"refresh_token",refresh_token:refresh};
 if(channel==="youtube"){body.client_id=credentials.id;body.client_secret=credentials.secret;}
 else headers.authorization="Basic "+btoa(credentials.id+":"+credentials.secret);
 const response=await fetchImpl(provider.token,{method:"POST",headers,body:new URLSearchParams(body),signal:AbortSignal.timeout(12000)});
 const token=await response.json().catch(()=>null);
 if(!response.ok||!token?.access_token||typeof token.access_token!=="string")throw Error("oauth_refresh_failed");
 // Continuous refresh rotates Pinterest's refresh token. Commit it to KV
 // *before* publishing; otherwise the next publication could use a stale token.
 if(token.refresh_token&&token.refresh_token!==refresh){
   const encryptedRefresh=await seal(env,token.refresh_token);
   await kv.put(connKey(channel),JSON.stringify({...stored,encryptedRefresh,refreshedAt:new Date().toISOString()}));
 }
 return token.access_token;
}

function finish(c,status){
 const u=new URL(panel);u.searchParams.set("oauth_channel",c);u.searchParams.set("oauth_result",status);
 return new Response(null,{status:303,headers:{location:u.toString(),"cache-control":"no-store","referrer-policy":"no-referrer","set-cookie":cookie(c,"",0)}});
}
async function ticketAuth(u,env,kv,c,action){
 const ts=u.searchParams.get("ts")||"",nonce=u.searchParams.get("nonce")||"",sig=u.searchParams.get("sig")||"";
 const key=String(env.OWNER_OAUTH_BRIDGE_SECRET||"");
 if(key.length<32||!/^\d{13}$/.test(ts)||!/^[a-zA-Z0-9_-]{40,128}$/.test(nonce)||!/^[a-zA-Z0-9_-]{43}$/.test(sig))return false;
 if(Math.abs(Date.now()-Number(ts))>60000)return false;
 const expected=await mac(key,["zpc-oauth-v1",action,c,ts,nonce].join("\n"));
 if(!eq(expected,sig)||await kv.get(ticketKey(nonce)))return false;
 await kv.put(ticketKey(nonce),"used",{expirationTtl:120});return true;
}
async function exchange(url,body,auth){
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",...(auth?{authorization:auth}:{})},body:new URLSearchParams(body),signal:AbortSignal.timeout(12000)});
 const json=await response.json().catch(()=>null);
 if(!response.ok||!json?.access_token||!json?.refresh_token)throw Error("token_unverified");
 return json;
}
export async function handleOwnerOAuth(req,env){
 const u=new URL(req.url),match=/^\/api\/owner\/oauth\/(youtube|pinterest)\/(start|callback|status|disconnect)$/.exec(u.pathname);
 if(!match)return result({error:"not_found"},404);
 const c=match[1],action=match[2],provider=OAUTH_PROVIDERS[c],kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put||!kv?.delete)return result({error:"secure_store_unavailable"},503);
 if(action!=="callback"){
  if(action==="start"&&req.method!=="GET"||action!=="start"&&req.method!=="POST")return result({error:"method_not_allowed"},405);
  if(!await ticketAuth(u,env,kv,c,action))return result({error:"owner_authorization_required"},401);
 }
 if(action==="status"){
  let data=null;try{data=JSON.parse(String(await kv.get(connKey(c))||"null"));}catch{}
  return result({channel:c,connected:Boolean(data?.encryptedRefresh),connectedAt:data?.connectedAt||null});
 }
 if(action==="disconnect"){
  await kv.delete(connKey(c));
  return result({channel:c,connected:false,providerRevocation:"not_confirmed"});
 }
 if(action==="start"){
  const auth=settings(env,c);
  if(!auth.id||!auth.secret)return result({error:"provider_credentials_missing"},503);
  try{await cipherKey(env);}catch{return result({error:"oauth_encryption_not_configured"},503);}
  const state=rand(),verifier=provider.pkce?rand():null;
  await kv.put(stateKey(state),JSON.stringify({c,at:Date.now(),verifier}),{expirationTtl:600});
  const target=new URL(provider.auth);
  for(const [name,value] of Object.entries({client_id:auth.id,redirect_uri:callback(c),response_type:"code",scope:provider.scope,state}))target.searchParams.set(name,value);
  if(provider.pkce){
    target.searchParams.set("access_type","offline");target.searchParams.set("prompt","consent");
    target.searchParams.set("code_challenge_method","S256");target.searchParams.set("code_challenge",await sha(verifier));
  }
  return new Response(null,{status:302,headers:{location:target.toString(),"set-cookie":cookie(c,state,600),"cache-control":"no-store","referrer-policy":"no-referrer"}});
 }
 if(req.method!=="GET")return result({error:"method_not_allowed"},405);
 const state=String(u.searchParams.get("state")||""),code=String(u.searchParams.get("code")||"");
 const stored=/^[A-Za-z0-9_-]{40,128}$/.test(state)?await kv.get(stateKey(state)):null;
 let challenge=null;try{challenge=JSON.parse(String(stored||"null"));}catch{}
 const rawCookie=(req.headers.get("cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName(c)+"="));
 const observed=rawCookie?rawCookie.slice(cookieName(c).length+1):"";
 if(!challenge||challenge.c!==c||Date.now()-challenge.at>600000||!eq(decodeURIComponent(observed),state))return finish(c,"invalid_state");
 await kv.delete(stateKey(state)); // replay and denial consume authorization
 if(u.searchParams.has("error")||!code||code.length>4096)return finish(c,"denied");
 const credentials=settings(env,c);
 if(!credentials.id||!credentials.secret)return finish(c,"not_configured");
 try{
   let token;
   if(c==="youtube"){
    token=await exchange(provider.token,{grant_type:"authorization_code",code,client_id:credentials.id,client_secret:credentials.secret,redirect_uri:callback(c),code_verifier:challenge.verifier});
   }else{
    token=await exchange(provider.token,{grant_type:"authorization_code",code,redirect_uri:callback(c),continuous_refresh:"true"},"Basic "+btoa(credentials.id+":"+credentials.secret));
   }
   const verify=await fetch(c==="youtube"?"https://www.googleapis.com/youtube/v3/channels?part=id&mine=true":"https://api.pinterest.com/v5/user_account",{headers:{authorization:"Bearer "+token.access_token},signal:AbortSignal.timeout(10000)});
   const profile=await verify.json().catch(()=>null);
   if(!verify.ok||(c==="youtube"?!profile?.items?.length:!profile?.username))throw Error("identity_unverified");
   const encryptedRefresh=await seal(env,token.refresh_token);
   await kv.put(connKey(c),JSON.stringify({schema:"zpc.owner.oauth.v1",channel:c,connectedAt:new Date().toISOString(),scope:String(token.scope||provider.scope),encryptedRefresh}));
   return finish(c,"connected");
 }catch{return finish(c,"provider_unverified");}
}

const youtubePublisherNonce=nonce=>"zpc:owner:oauth:youtube-publisher:"+nonce;
export async function handleYoutubePublisherAccess(req,env,fetchImpl=fetch){
 const headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
 if(req.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405,headers});
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put)return Response.json({error:"secure_store_unavailable"},{status:503,headers});
 let body;try{body=await req.json();}catch{return Response.json({error:"invalid_request"},{status:400,headers});}
 const ts=String(body?.ts||""),nonce=String(body?.nonce||""),sig=String(body?.sig||"");
 const secret=settings(env,"youtube").secret;
 if(secret.length<12||!/^[0-9]{13}$/.test(ts)||Math.abs(Date.now()-Number(ts))>60000||
    !/^[A-Za-z0-9_-]{40,128}$/.test(nonce)||!/^[A-Za-z0-9_-]{43}$/.test(sig))
      return Response.json({error:"publisher_unauthorized"},{status:401,headers});
 const expected=await mac(secret,["zpc-youtube-publisher-v1",ts,nonce].join("\n"));
 if(!eq(sig,expected)||await kv.get(youtubePublisherNonce(nonce)))
   return Response.json({error:"publisher_unauthorized"},{status:401,headers});
 await kv.put(youtubePublisherNonce(nonce),"used",{expirationTtl:120});
 try{
   const access=await resolveOwnerPublisherToken(env,"youtube",fetchImpl);
   if(!access)return Response.json({connected:false},{headers});
   return Response.json({connected:true,access_token:access},{headers});
 }catch{return Response.json({error:"publisher_refresh_unavailable"},{status:503,headers});}
}
