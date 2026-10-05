// Manual only. No timers/schedules. Existing KV entries are the durable resume cursor.
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { SUPPORT_PRODUCTS } from '../worker/support-knowledge.mjs';
import { deterministicReply, speechText } from '../worker/whatsapp-conversation.mjs';
import { synthesizeVoice, voiceCacheKey } from '../worker/voice-remote-tts.mjs';

export function catalogVoices() {
  return Object.entries(SUPPORT_PRODUCTS).flatMap(([product,p]) => [
    ['price',`Quanto custa ${p.name}?`],
    ['delivery',`Como recebo ${p.name}?`],
    ['refund',`Quero reembolso de ${p.name}`],
  ].map(([intent,question]) => ({product,intent,question,text:speechText(deterministicReply(question).body)})));
}
export async function warmVoiceCache({kv,apiKey,secret,fetchImpl=fetch,max=10,onProgress=()=>{}}) {
  if(!Number.isInteger(max)||max<1||max>10)throw Error('warm_limit_1_to_10');
  let attempted=0,generated=0,cached=0;const seen=new Set();
  for(const entry of catalogVoices()) {
    const key=await voiceCacheKey(entry.text);
    if(seen.has(key))continue;seen.add(key);
    try {
      const hit=await synthesizeVoice(entry.text,{kv,cacheOnly:true});
      if(hit.cached){cached++;onProgress({...entry,key,cached:true});continue;}
    } catch(e) {if(e.message!=='voice_cache_miss')throw e;}
    if(attempted>=max)break;
    attempted++;
    try {
      const audio=await synthesizeVoice(entry.text,{kv,apiKey,secret,fetchImpl});
      if(!audio.cached)generated++;
      onProgress({...entry,key,cached:audio.cached});
    } catch(e) {
      // Do not continue to other products, fallback models or retry on quota.
      if(e.message==='quota')return {stopped:'quota',attempted,generated,cached};
      throw e;
    }
  }
  return {stopped:attempted>=max?'limit':'complete',attempted,generated,cached};
}

export async function cloudKv(env,fetchImpl=fetch) {
  const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
  if(!account||!token)throw Error('cloudflare_credentials_required');
  const root=`https://api.cloudflare.com/client/v4/accounts/${account}`;
  const headers={authorization:`Bearer ${token}`};
  const settings=await fetchImpl(`${root}/workers/scripts/zevanory/settings`,{headers});
  if(!settings.ok)throw Error(`worker_settings_http_${settings.status}`);
  const binding=(await settings.json()).result?.bindings?.find(b=>b.name==='ZEVANORY_PRIVATE_ARTIFACTS');
  if(!binding?.namespace_id)throw Error('private_kv_required');
  const url=k=>`${root}/storage/kv/namespaces/${binding.namespace_id}/values/${encodeURIComponent(k)}`;
  return {
    async get(k){const r=await fetchImpl(url(k),{headers});if(r.status===404)return null;if(!r.ok)throw Error(`kv_read_http_${r.status}`);return r.arrayBuffer();},
    async put(k,v,{expirationTtl}){const r=await fetchImpl(`${url(k)}?expiration_ttl=${expirationTtl}`,{method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},body:v});if(!r.ok)throw Error(`kv_write_http_${r.status}`);},
  };
}
export async function renderSecret(env,fetchImpl=fetch) {
  if(env.VOICE_ENCODE_SECRET)return env.VOICE_ENCODE_SECRET;
  if(!env.OPERATOR_TOKEN)throw Error('operator_token_required');
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const r=await fetchImpl('https://zevanory.api.br/api/admin/whatsapp-onboard/delivery-proof',{method:'POST',headers:{authorization:`Bearer ${env.OPERATOR_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({operation:'audit-encoder-key',public_key:publicKey.export({format:'jwk'})})});
  if(!r.ok)throw Error(`render_secret_http_${r.status}`);
  const body=await r.json();
  return privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(body.wrapped_key,'base64')).toString();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const entries=[];mkdirSync('/tmp/voice-warm',{recursive:true});
  const save=result=>writeFileSync('/tmp/voice-warm/summary.json',JSON.stringify({entries,...result},null,2));
  try {
    if(!process.env.GEMINI_API_KEY)throw Error('gemini_key_required');
    const kv=await cloudKv(process.env),secret=await renderSecret(process.env);
    const result=await warmVoiceCache({kv,secret,apiKey:process.env.GEMINI_API_KEY,max:Number(process.env.VOICE_WARM_MAX||10),onProgress:e=>{entries.push({...e,recorded:!e.cached});save({state:'running'});console.log(JSON.stringify(e));}});
    save(result);console.log(JSON.stringify(result));
    if(result.stopped==='quota')console.log('::warning title=GEMINI_QUOTA::Stopped immediately; existing keys preserved; no automatic resume');
  }catch(error){save({stopped:'error',cause:error.message});console.error('::error title=VOICE_CACHE_WARM::'+error.message);process.exitCode=1;}
}
