import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { defineExecutionProvider, providerSatisfies } from './universalExecutionFabric.mjs';
import { safeBearerEqual } from './security.mjs';

const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);
const sha=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyFrom=(value)=>{
  const raw=Buffer.from(clean(value,500),'base64');
  if(raw.length!==32)throw new Error('journal_encryption_key_invalid');
  return raw;
};

export function buildJournalEntry({operationId,operationType,payload,createdAt=new Date().toISOString()}={}){
  const id=clean(operationId,200);const type=clean(operationType,120);
  if(!id||!type||payload===undefined)throw new Error('journal_entry_invalid');
  return Object.freeze({schema_version:1,operation_id:id,operation_type:type,created_at:createdAt,payload,payload_sha256:sha(payload)});
}

export function sealJournalEntry(entry,encryptionKey){
  const key=keyFrom(encryptionKey);const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
  const plaintext=Buffer.from(JSON.stringify(entry.payload));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);const tag=cipher.getAuthTag();
  return Object.freeze({schema_version:1,operation_id:entry.operation_id,operation_type:entry.operation_type,created_at:entry.created_at,payload_sha256:entry.payload_sha256,iv_b64:iv.toString('base64'),tag_b64:tag.toString('base64'),ciphertext_b64:ciphertext.toString('base64')});
}
export function openJournalEntry(envelope,encryptionKey){
  const key=keyFrom(encryptionKey);const iv=Buffer.from(envelope.iv_b64,'base64');const tag=Buffer.from(envelope.tag_b64,'base64');
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
  const plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext_b64,'base64')),decipher.final()]);
  const payload=JSON.parse(plaintext.toString('utf8'));
  if(sha(payload)!==envelope.payload_sha256)throw new Error('journal_payload_integrity_failed');
  return Object.freeze({...envelope,payload});
}

export function defineJournalProvider({id,append,ready=()=>true,independenceDomain=null,cost=0}={}){
  if(typeof append!=='function')throw new Error('journal_provider_invalid');
  return defineExecutionProvider({id,capabilities:['durable:journal'],cost,independenceDomain,
    health:async()=>Boolean(await ready())?{state:'available'}:{state:'unavailable'},
    execute:append,
  });
}

export async function appendJournalQuorum(entry,providers=[],{requiredCopies=1}={}){
  const candidates=providers.filter(p=>providerSatisfies(p,{capabilities:['durable:journal'],zeroCost:true}));
  const accepted=[];const failed=[];const domains=new Set();
  for(const provider of candidates){
    if(domains.has(provider.independence_domain))continue;
    let health;try{health=await provider.health();}catch{health={state:'unavailable'};}
    if(!['available','recovering','degraded'].includes(health?.state))continue;
    try{const result=await provider.execute(entry);accepted.push({provider:provider.id,independence_domain:provider.independence_domain,result});domains.add(provider.independence_domain);}
    catch(error){failed.push({provider:provider.id,reason:clean(error?.message||'journal_append_failed',240)});}
  }
  const required=Math.max(1,Number(requiredCopies)||1);const preserved=accepted.length>=required;
  return Object.freeze({preserved,required_copies:required,copies:accepted.length,independent_domains:domains.size,accepted:Object.freeze(accepted),failed:Object.freeze(failed),reason:preserved?'journal_quorum_satisfied':'journal_quorum_not_satisfied'});
}
export function buildHttpJournalProvider({id='remote-journal',endpoint,token,encryptionKey,independenceDomain='remote-journal',fetchImpl=globalThis.fetch}={}){
  const url=clean(endpoint,2000);const secret=clean(token,4000);const key=clean(encryptionKey,500);
  return defineJournalProvider({id,independenceDomain,cost:0,ready:()=>Boolean(url&&secret&&key&&typeof fetchImpl==='function'),append:async(entry)=>{
    if(!url||!secret||!key)throw new Error('remote_journal_not_configured');
    const envelope=sealJournalEntry(entry,key);
    const response=await fetchImpl(url,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json','idempotency-key':entry.operation_id},body:JSON.stringify(envelope)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`remote_journal_http_${response.status}`);
    if(body?.preserved!==true)throw new Error('remote_journal_not_acknowledged');
    return Object.freeze({preserved:true,journal_ref:clean(body.journal_ref||entry.operation_id,300)});
  }});
}

export async function handleCloudflareJournalAppend(request,env){
  if(request.method!=='POST')return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:{'content-type':'application/json'}});
  const supplied=String(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(String(env.DURABLE_JOURNAL_TOKEN||''),supplied))return new Response(JSON.stringify({error:'journal_auth_required'}),{status:401,headers:{'content-type':'application/json'}});
  if(!env.ZEVANORY_PRIVATE_ARTIFACTS)return new Response(JSON.stringify({error:'journal_storage_unavailable'}),{status:503,headers:{'content-type':'application/json'}});
  const text=await request.text();if(text.length>65536)return new Response(JSON.stringify({error:'payload_too_large'}),{status:413,headers:{'content-type':'application/json'}});
  let body;try{body=JSON.parse(text||'{}');}catch{return new Response(JSON.stringify({error:'invalid_json'}),{status:400,headers:{'content-type':'application/json'}});}
  if(!clean(body.operation_id,200)||!clean(body.ciphertext_b64,65000)||!clean(body.payload_sha256,64))return new Response(JSON.stringify({error:'journal_envelope_invalid'}),{status:400,headers:{'content-type':'application/json'}});
  const key=`opjournal:${clean(body.operation_id,200)}`;await env.ZEVANORY_PRIVATE_ARTIFACTS.put(key,JSON.stringify(body));
  return new Response(JSON.stringify({preserved:true,journal_ref:key}),{status:201,headers:{'content-type':'application/json','cache-control':'no-store'}});
}
