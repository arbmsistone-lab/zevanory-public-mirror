import test from "node:test";
import assert from "node:assert/strict";
import { handleOwnerOAuth, OAUTH_PROVIDERS } from "../worker/owner-oauth.mjs";
const base="https://zevanory.api.br/api/owner/oauth/";
const env=()=>({
 OWNER_OAUTH_BRIDGE_SECRET:"bridge-high-entropy-12345678901234567890",
 OWNER_OAUTH_ENCRYPTION_KEY:"encryption-high-entropy-12345678901234567890",
 YOUTUBE_CLIENT_ID:"client.apps.googleusercontent.com",YOUTUBE_CLIENT_SECRET:"client-secret",
 PINTEREST_CLIENT_ID:"pinterest-id",PINTEREST_CLIENT_SECRET:"pinterest-secret",
 ZEVANORY_PRIVATE_ARTIFACTS:new MapKV()
});
class MapKV{
 data=new Map();
 async get(k){return this.data.get(k)||null;}
 async put(k,v){this.data.set(k,v);}
 async delete(k){this.data.delete(k);}
}
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function url(action,channel,env){
 const ts=String(Date.now()),nonce=b64(crypto.getRandomValues(new Uint8Array(32)));
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.OWNER_OAUTH_BRIDGE_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=b64(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(["zpc-oauth-v1",action,channel,ts,nonce].join("\n"))));
 return base+channel+"/"+action+"?"+new URLSearchParams({ts,nonce,sig});
}
test("start requires a PIN-signed ticket and fails closed for absent config",async()=>{
 const e=env();const r=await handleOwnerOAuth(new Request(base+"youtube/start"),e);
 assert.equal(r.status,401);
 const v=await url("start","youtube",e);e.OWNER_OAUTH_ENCRYPTION_KEY="";
 const notConfigured=await handleOwnerOAuth(new Request(v),e);
 assert.equal(notConfigured.status,503);
});
test("YouTube start uses offline PKCE S256 and a single-use ticket",async()=>{
 const e=env(),start=await url("start","youtube",e);
 const response=await handleOwnerOAuth(new Request(start),e);
 assert.equal(response.status,302);
 const u=new URL(response.headers.get("location"));
 assert.equal(u.origin,"https://accounts.google.com");
 assert.equal(u.searchParams.get("code_challenge_method"),"S256");
 assert.equal(u.searchParams.get("access_type"),"offline");
 assert.equal(u.searchParams.get("prompt"),"consent");
 assert.match(response.headers.get("set-cookie"),/HttpOnly; SameSite=Lax/);
 assert.equal((await handleOwnerOAuth(new Request(start),e)).status,401);
});
test("Pinterest start uses documented Authorization Code and state; no invented PKCE",async()=>{
 const e=env(),r=await handleOwnerOAuth(new Request(await url("start","pinterest",e)),e);
 assert.equal(r.status,302);
 const u=new URL(r.headers.get("location"));
 assert.equal(u.origin,"https://www.pinterest.com");
 assert.equal(u.searchParams.get("scope"),OAUTH_PROVIDERS.pinterest.scope);
 assert.equal(u.searchParams.get("code_challenge"),null);
 assert.ok(u.searchParams.get("state"));
});
test("callback refuses missing state and mismatched channel/cookie",async()=>{
 const e=env(),request=await url("start","youtube",e),start=await handleOwnerOAuth(new Request(request),e);
 const u=new URL(start.headers.get("location"));
 const state=u.searchParams.get("state");
 let result=await handleOwnerOAuth(new Request(base+"youtube/callback?"+new URLSearchParams({state,code:"abc"})),e);
 assert.equal(result.status,303);
 assert.equal(new URL(result.headers.get("location")).searchParams.get("oauth_result"),"invalid_state");
 const invalidCookie=new Request(base+"youtube/callback?"+new URLSearchParams({state,code:"abc"}),{headers:{cookie:"zpc_oauth_state_youtube=wrong"}});
 result=await handleOwnerOAuth(invalidCookie,e);
 assert.equal(new URL(result.headers.get("location")).searchParams.get("oauth_result"),"invalid_state");
});
test("YouTube exchanges one code, verifies channel and encrypts refresh token without plaintext",async()=>{
 const e=env(),start=await handleOwnerOAuth(new Request(await url("start","youtube",e)),e);
 const state=new URL(start.headers.get("location")).searchParams.get("state");
 const cookie=start.headers.get("set-cookie").split(";")[0];
 const original=globalThis.fetch;let posts=0;
 globalThis.fetch=async (target,init={})=>{
  if(String(target)==="https://oauth2.googleapis.com/token"){
   posts++;
   assert.equal(new URLSearchParams(init.body).get("grant_type"),"authorization_code");
   assert.ok(new URLSearchParams(init.body).get("code_verifier"));
   return Response.json({access_token:"ACCESS_NOT_STORED",refresh_token:"REFRESH_NOT_STORED",scope:OAUTH_PROVIDERS.youtube.scope});
  }
  if(String(target).startsWith("https://www.googleapis.com/youtube/"))return Response.json({items:[{id:"channel"}]});
  throw Error("untrusted_endpoint");
 };
 try{
  const callback=new Request(base+"youtube/callback?"+new URLSearchParams({state,code:"auth-code"}),{headers:{cookie}});
  const r=await handleOwnerOAuth(callback,e);
  assert.equal(new URL(r.headers.get("location")).searchParams.get("oauth_result"),"connected");
  assert.equal(posts,1);
  const raw=String(await e.ZEVANORY_PRIVATE_ARTIFACTS.get("zpc:owner:oauth:connection:youtube:v1"));
  assert.doesNotMatch(raw,/REFRESH_NOT_STORED|ACCESS_NOT_STORED|auth-code/);
  assert.match(raw,/AES-256-GCM/);
  const replay=await handleOwnerOAuth(callback,e);
  assert.equal(new URL(replay.headers.get("location")).searchParams.get("oauth_result"),"invalid_state");
 }finally{globalThis.fetch=original;}
});
test("status and disconnect need distinct signed POST; neither returns tokens",async()=>{
 const e=env();
 const status=await handleOwnerOAuth(new Request(await url("status","pinterest",e),{method:"POST"}),e);
 assert.deepEqual(await status.json(),{channel:"pinterest",connected:false,connectedAt:null});
 const disconnect=await handleOwnerOAuth(new Request(await url("disconnect","pinterest",e),{method:"POST"}),e);
 assert.equal((await disconnect.json()).providerRevocation,"not_confirmed");
 const nope=await handleOwnerOAuth(new Request(base+"pinterest/disconnect",{method:"POST"}),e);
 assert.equal(nope.status,401);
});
