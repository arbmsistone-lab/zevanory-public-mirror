import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
const clean=(v,max=4000)=>String(v??'').trim().slice(0,max);
const keyFrom=(env)=>{const raw=Buffer.from(clean(env.COMMERCIAL_OAUTH_ENCRYPTION_KEY,200),'base64');if(raw.length!==32)throw new Error('commercial_oauth_encryption_key_invalid');return raw;};
const b64u=(v)=>Buffer.from(v).toString('base64url');
export function encryptCommercialSecret(value,env=process.env){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',keyFrom(env),iv);const data=Buffer.concat([c.update(String(value),'utf8'),c.final()]);return [b64u(iv),b64u(c.getAuthTag()),b64u(data)].join('.');}
export function decryptCommercialSecret(value,env=process.env){const p=String(value||'').split('.');if(p.length!==3)throw new Error('commercial_oauth_ciphertext_invalid');const [iv,tag,data]=p.map(x=>Buffer.from(x,'base64url'));const d=createDecipheriv('aes-256-gcm',keyFrom(env),iv);d.setAuthTag(tag);return Buffer.concat([d.update(data),d.final()]).toString('utf8');}
export function newOAuthState(){return b64u(randomBytes(24));}
export function sealOAuthSession(payload,env=process.env){return encryptCommercialSecret(JSON.stringify({...payload,iat:Date.now()}),env);}
export function openOAuthSession(value,env=process.env){const p=JSON.parse(decryptCommercialSecret(value,env));if(Date.now()-Number(p.iat)>10*60*1000)throw new Error('commercial_oauth_session_expired');return p;}
export function assertOAuthState(actual,expected){const a=Buffer.from(clean(actual,200)),b=Buffer.from(clean(expected,200));if(!a.length||a.length!==b.length||!timingSafeEqual(a,b))throw new Error('commercial_oauth_state_invalid');}
