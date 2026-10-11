// CI publisher bridge for any owner-connected channel (tiktok, ...). The refresh
// token never leaves the L Worker; CI proves knowledge of the provider client
// secret with a single-use HMAC ticket and receives a short-lived access token.
const b64=x=>btoa(String.fromCharCode(...x)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
export async function getPublisherAccessToken(channel,secret,fetchImpl=fetch){
 secret=String(secret||"").trim();
 if(secret.length<12)return {connected:false,reason:channel+"_client_missing"};
 const ts=String(Date.now()),nonce=b64(crypto.getRandomValues(new Uint8Array(32)));
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=b64(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(["zpc-"+channel+"-publisher-v1",ts,nonce].join("\n")))));
 const r=await fetchImpl(`https://zevanory.api.br/api/internal/owner/oauth/${channel}-access`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ts,nonce,sig}),signal:AbortSignal.timeout(15000)});
 const body=await r.json().catch(()=>null);
 if(!r.ok)throw Error(channel+"_bridge_http_"+r.status);
 if(body?.connected===true&&typeof body.access_token==="string")return {connected:true,token:body.access_token};
 if(body?.connected===false)return {connected:false,reason:channel+"_not_connected"};
 throw Error(channel+"_bridge_invalid");
}
