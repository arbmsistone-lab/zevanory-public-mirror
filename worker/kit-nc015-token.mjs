// NC-015: per-purchase bearer token, never indexed in KV or logged.
// The token is reproducible for outbox recovery, but usable only when the
// corresponding SQLite purchase is ready, unrefunded, in time and under quota.
const enc=new TextEncoder();
const hex=a=>[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("");
const unhex=s=>new Uint8Array(s.match(/../g).map(x=>parseInt(x,16)));
const ORDER=/^kr:[a-f0-9]{64}$/;
const SECRET=/^[a-f0-9]{64}$/;
async function hmac(key,body){
 if(typeof key!=="string"||key.length<32)throw Error("kit_download_secret_missing");
 const k=await crypto.subtle.importKey("raw",enc.encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return hex(await crypto.subtle.sign("HMAC",k,enc.encode(body)));
}
function eq(a,b){
 if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;
 let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);
 return d===0;
}
export async function orderDownloadSecret(orderOpaque,signingKey){
 if(!ORDER.test(orderOpaque))throw Error("kit_order_invalid");
 return await hmac(signingKey,"kit-download-material/v1|"+orderOpaque);
}
export async function issueSignedKitToken(orderOpaque,signingKey){
 const raw=await orderDownloadSecret(orderOpaque,signingKey);
 const claim="v1."+orderOpaque.slice(3)+"."+raw;
 return claim+"."+await hmac(signingKey,"kit-download-link|"+claim);
}
export async function verifySignedKitToken(token,signingKey){
 if(typeof token!=="string"||token.length>260)return null;
 const p=token.split(".");
 if(p.length!==4||p[0]!=="v1"||!SECRET.test(p[1])||!SECRET.test(p[2])||!SECRET.test(p[3]))return null;
 const orderOpaque="kr:"+p[1];
 try{
  if(!eq(p[2],await orderDownloadSecret(orderOpaque,signingKey)))return null;
  if(!eq(p[3],await hmac(signingKey,"kit-download-link|"+p.slice(0,3).join("."))))return null;
  return {orderOpaque,rawToken:p[2]};
 }catch{return null}
}
export async function grantPreparedKitToken(ledger,now,proof,signingKey){
 const material=unhex(await orderDownloadSecret(ledger.orderOpaque,signingKey));
 return ledger.prepareGrant(now,proof,{randomBytes:()=>material});
}
