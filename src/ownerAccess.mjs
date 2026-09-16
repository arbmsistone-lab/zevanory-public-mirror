const COOKIE_NAME='__Host-zevanory_owner';
const SESSION_SECONDS=8*60*60;
const CREDENTIAL_KEY='owner:credential:v1';
const enc=new TextEncoder();

function sessionSecret(env={}){
  return String(env.OWNER_DASHBOARD_SECRET||env.OPERATOR_TOKEN||'').trim();
}
function toBase64Url(bytes){
  let binary=''; for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function fromBase64Url(value){
  const normalized=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const binary=atob(padded),out=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i); return out;
}
async function digest(value){
  return new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(String(value||''))));
}
function sameBytes(a,b){
  if(a.length!==b.length)return false; let diff=0;
  for(let i=0;i<a.length;i++)diff|=a[i]^b[i]; return diff===0;
}
async function hmac(secret,value){
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value)));
}
async function deriveLegacyPassword(password,salt,iterations){
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));
}
async function credentialMac(env,password,salt){
  const secret=sessionSecret(env); if(secret.length<24)throw new Error('owner_secret_unavailable');
  return hmac(secret,`owner-password-v2:${salt}:${String(password||'')}`);
}
export async function setOwnerCredential(env,kv,password){
  const value=String(password||'');
  if(!kv||value.length<8)throw new Error('owner_password_invalid');
  const salt=toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const hash=await credentialMac(env,value,salt);
  await kv.put(CREDENTIAL_KEY,JSON.stringify({v:2,salt,hash:toBase64Url(hash)}));
}
export async function verifyOwnerCredential(env,provided,kv){
  const value=String(provided||''); if(value.length<8)return false;
  if(kv){
    const raw=await kv.get(CREDENTIAL_KEY);
    if(raw){try{
      const r=JSON.parse(raw);
      if(Number(r.v)===2){const actual=await credentialMac(env,value,String(r.salt||''));return sameBytes(actual,fromBase64Url(r.hash));}
      if(Number(r.v)===1){const actual=await deriveLegacyPassword(value,fromBase64Url(r.salt),Number(r.iterations));return sameBytes(actual,fromBase64Url(r.hash));}
      return false;
    }catch{return false;}}
  }
  const legacy=sessionSecret(env); if(legacy.length<24||value.length<24)return false;
  return sameBytes(await digest(legacy),await digest(value));
}
export async function createOwnerSession(env){
  const secret=sessionSecret(env); if(secret.length<24)throw new Error('owner_secret_unavailable');
  const now=Math.floor(Date.now()/1000),nonce=toBase64Url(crypto.getRandomValues(new Uint8Array(16))),payload=`v1.${now}.${now+SESSION_SECONDS}.${nonce}`;
  const sig=toBase64Url(await hmac(secret,payload));
  return `${payload}.${sig}`;
}
export async function verifyOwnerSession(env,token){
  const secret=sessionSecret(env); if(secret.length<24)return false;
  const parts=String(token||'').split('.'); if(parts.length!==5||parts[0]!=='v1')return false;
  const issued=Number(parts[1]),expires=Number(parts[2]);
  if(!Number.isInteger(issued)||!Number.isInteger(expires)||expires<=Math.floor(Date.now()/1000)||expires-issued!==SESSION_SECONDS)return false;
  if(!/^[A-Za-z0-9_-]{20,30}$/.test(parts[3]))return false;
  const expected=await hmac(secret,parts.slice(0,4).join('.'));
  let actual; try{actual=fromBase64Url(parts[4]);}catch{return false;}
  return sameBytes(expected,actual);
}
export function ownerCookie(token){return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;}
export function clearOwnerCookie(){return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;}
export function readOwnerCookie(request){
  const raw=String(request.headers.get('cookie')||'');
  const hit=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE_NAME}=`));
  return hit?hit.slice(COOKIE_NAME.length+1):'';
}
export async function ownerSetupKey(token){return 'owner:setup:'+toBase64Url(await digest(token));}
