// CI YouTube publisher bridge. The refresh token never leaves the L Worker.
const b64=x=>btoa(String.fromCharCode(...x)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
export async function getYoutubeAccessToken(env=process.env,fetchImpl=fetch){
 const secret=String(env.YOUTUBE_CLIENT_SECRET||"");
 const ts=String(Date.now());
 const nonce=b64(crypto.getRandomValues(new Uint8Array(32)));
 if(secret.length<12||!String(env.YOUTUBE_CLIENT_ID||""))throw Error("youtube_oauth_client_missing");
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const msg=["zpc-youtube-publisher-v1",ts,nonce].join("\n");
 const sig=b64(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(msg))));
 const response=await fetchImpl("https://zevanory.api.br/api/internal/owner/oauth/youtube-access",{
   method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({ts,nonce,sig}),signal:AbortSignal.timeout(12000)
 });
 if(!response.ok)throw Error("youtube_oauth_bridge_unavailable");
 const body=await response.json().catch(()=>null);
 if(body?.connected===true){
   if(!body.access_token||typeof body.access_token!=="string")throw Error("youtube_oauth_bridge_invalid");
   return body.access_token;
 }
 if(body?.connected!==false)throw Error("youtube_oauth_bridge_invalid");
 // Fallback is allowed ONLY if KV has no connection; never mask failed refresh.
 const refresh=String(env.YOUTUBE_REFRESH_TOKEN||"");
 if(!refresh)throw Error("youtube_legacy_refresh_missing");
 const res=await fetchImpl("https://oauth2.googleapis.com/token",{
   method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({client_id:String(env.YOUTUBE_CLIENT_ID),client_secret:secret,refresh_token:refresh,grant_type:"refresh_token"})
 });
 const token=await res.json().catch(()=>null);
 if(!res.ok||!token?.access_token)throw Error("youtube_legacy_token_unverified");
 return token.access_token;
}
