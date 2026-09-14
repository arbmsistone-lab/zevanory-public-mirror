const encoder=new TextEncoder();
const decoder=new TextDecoder();
const PROVIDERS=new Set(['groq','openrouter']);

const bytesToB64=(bytes)=>{
  let s=''; for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s);
};
const b64ToBytes=(value)=>{
  const s=atob(String(value||'')),out=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i);
  return out;
};
const bytesToHex=(bytes)=>[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');

async function aesKey(master){
  if(!master||String(master).length<32)throw new Error('ai_vault_master_key_invalid');
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(String(master)));
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}

export async function deriveAiVaultIngestToken(master){
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(`zevanory-ai-vault-ingest|${String(master||'')}`));
  return bytesToHex(new Uint8Array(digest));
}
export async function encryptAiVaultSecret(secret,master){
  if(!secret||String(secret).length<12)throw new Error('ai_vault_secret_invalid');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await aesKey(master);
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(String(secret)));
  return Object.freeze({v:1,alg:'AES-GCM',iv:bytesToB64(iv),cipher:bytesToB64(new Uint8Array(cipher))});
}

export async function decryptAiVaultSecret(record,master){
  if(Number(record?.v)!==1||record?.alg!=='AES-GCM')throw new Error('ai_vault_record_invalid');
  const key=await aesKey(master),iv=b64ToBytes(record.iv),cipher=b64ToBytes(record.cipher);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,cipher);
  return decoder.decode(plain);
}

export async function storeAiVaultSecret(provider,secret,{kv=globalThis.__ZEVANORY_PRIVATE_KV__,master=process.env.AI_VAULT_ENCRYPTION_KEY}={}){
  provider=String(provider||'').toLowerCase();
  if(!PROVIDERS.has(provider))throw new Error('ai_vault_provider_forbidden');
  if(!kv?.put)throw new Error('ai_vault_kv_unavailable');
  const encrypted=await encryptAiVaultSecret(secret,master);
  await kv.put(`ai-vault:${provider}`,JSON.stringify({...encrypted,provider,updated_at:new Date().toISOString()}));
  return Object.freeze({ok:true,provider,encrypted:true});
}
export async function loadAiVaultSecret(provider,{kv=globalThis.__ZEVANORY_PRIVATE_KV__,master=process.env.AI_VAULT_ENCRYPTION_KEY}={}){
  provider=String(provider||'').toLowerCase();
  if(!PROVIDERS.has(provider)||!kv?.get||!master)return null;
  const raw=await kv.get(`ai-vault:${provider}`);
  if(!raw)return null;
  let record; try{record=JSON.parse(raw);}catch{return null;}
  try{return await decryptAiVaultSecret(record,master);}catch{return null;}
}

export function constantTimeEqual(a,b){
  a=String(a||''); b=String(b||'');
  if(a.length!==b.length)return false;
  let diff=0; for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

export async function aiVaultStatus({kv=globalThis.__ZEVANORY_PRIVATE_KV__}={}){
  const providers=[];
  if(kv?.get)for(const provider of PROVIDERS)if(await kv.get(`ai-vault:${provider}`))providers.push(provider);
  return Object.freeze({configured:providers.length,providers:Object.freeze(providers.sort()),encrypted:true});
}
