const encoder = new TextEncoder();

function store(){
  return globalThis.__ZEVANORY_WHATSAPP_E2E_STORE__ || null;
}
async function sha256(value){
  const digest=await crypto.subtle.digest("SHA-256",encoder.encode(String(value||"")));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function safe(v,max=300){return String(v??"").trim().slice(0,max);}
function bool(v){return v===true;}
function releaseSha(env={}) {
  const sha=String(env.ZEVANORY_RELEASE_SHA||globalThis.__ZEVANORY_RELEASE_SHA__||"").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha)?sha:"";
}
export async function recordWhatsappEvidence(type,payload={}){
  const kv=store();
  if(!kv?.put) return false;
  const ts=new Date().toISOString();
  const release_sha=releaseSha(); if(!release_sha) return false;
  const contact=safe(payload.contact_ref||payload.recipient_id,100);
  const record={
    schema_version:1,
    release_sha,
    type:safe(type,80),
    created_at:ts,
    message_id:safe(payload.message_id,300)||null,
    provider_message_id:safe(payload.provider_message_id,300)||null,
    phone_number_id:safe(payload.phone_number_id,120)||null,
    contact_hash:contact?await sha256(contact):null,
    queued:bool(payload.queued),
    generated_voice:bool(payload.generated_voice),
    status:safe(payload.status,40)||null,
    kind:safe(payload.kind,80)||null,
    event_id:safe(payload.event_id,300)||null
  };
  const suffix=crypto.randomUUID();
  await kv.put(`whatsapp-e2e/${release_sha}/`+Date.now()+"-"+suffix,JSON.stringify(record),{expirationTtl:60*60*24*30});
  return true;
}
async function listEvidence(env={}){
  const kv=env.ZEVANORY_PRIVATE_ARTIFACTS||store();
  if(!kv?.list) return [];
  const sha=releaseSha(env); if(!sha) return [];
  const out=[]; let cursor=undefined;
  do{
    const page=await kv.list({prefix:`whatsapp-e2e/${sha}/`,limit:1000,cursor});
    for(const key of page.keys||[]){
      const item=await kv.get(key.name,{type:"json"}).catch(()=>null);
      if(item) out.push(item);
    }
    cursor=page.list_complete?undefined:page.cursor;
  }while(cursor);
  out.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}
export async function whatsappE2EStatus(env={}){
  const sha=releaseSha(env);
  const events=(await listEvidence(env)).filter(x=>x.release_sha===sha);
  const inbound=events.filter(x=>x.type==="inbound_processed"&&x.queued===true&&x.contact_hash);
  const outbound=events.filter(x=>x.type==="outbound_voice"&&x.generated_voice===true&&x.provider_message_id&&x.contact_hash);
  const delivery=events.filter(x=>x.type==="delivery"&&["delivered","read"].includes(String(x.status||"").toLowerCase())&&x.provider_message_id);
  let chain=null;
  for(const i of inbound){
    for(const o of outbound){
      if(i.contact_hash!==o.contact_hash||String(o.created_at)<=String(i.created_at)) continue;
      const d=delivery.find(x=>x.provider_message_id===o.provider_message_id&&String(x.created_at)>=String(o.created_at));
      if(d){chain={inbound:i,outbound:o,delivery:d}; break;}
    }
    if(chain) break;
  }
  return Object.freeze({
    release_sha:sha||null,
    inbound:inbound.length>0,
    runtime_processing:inbound.length>0,
    tts:outbound.length>0,
    outbound:outbound.length>0,
    delivery:delivery.length>0,
    e2e:Boolean(chain),
    event_count:events.length,
    chain:chain?{
      release_sha:chain.inbound.release_sha,
      inbound_message_id:chain.inbound.message_id,
      outbound_provider_message_id:chain.outbound.provider_message_id,
      delivery_status:chain.delivery.status,
      started_at:chain.inbound.created_at,
      completed_at:chain.delivery.created_at
    }:null
  });
}
