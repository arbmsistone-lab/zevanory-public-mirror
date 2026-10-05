const E=new TextEncoder(),TTL=30*86400;
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
let cooldown=0;
export async function voiceReserveSecret(env){
 if(String(env.VOICE_ENCODE_SECRET||'').length>=32)return String(env.VOICE_ENCODE_SECRET);
 const secret=String(env.ELITE_INTERNAL_TOKEN||'');if(secret.length<24)throw Error('voice_signing_key_missing');
 const k=await crypto.subtle.importKey('raw',E.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',k,E.encode('zevanory-render-voice-v1')));
}
export async function reserveHeaders(env,bodyDigest,mode,rate){
 const timestamp=String(Date.now()),nonce=crypto.randomUUID();
 const message=(mode==='synthesize'?['zevanory-voice-synth-v1',timestamp,nonce,bodyDigest]:[timestamp,nonce,rate,bodyDigest]).join('\n');
 const key=await crypto.subtle.importKey('raw',E.encode(await voiceReserveSecret(env)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return {'x-voice-timestamp':timestamp,'x-voice-nonce':nonce,'x-voice-signature':hex(await crypto.subtle.sign('HMAC',key,E.encode(message)))};
}
export async function voiceCacheKey(text){return 'voice:mp3:v2:'+hex(await crypto.subtle.digest('SHA-256',E.encode(String(text).trim())));}
export async function renderTextTts(text,env,fetchImpl=fetch,{onStage=async()=>{},kv=globalThis.__ZEVANORY_PRIVATE_KV__}={}){
 if(!text||text.length>350)throw Error('voice_speech_text_limit');
 const cacheKey=await voiceCacheKey(text);
 const cached=kv?.get?await kv.get(cacheKey,'arrayBuffer').catch(()=>null):null;
 if(cached){await onStage('tts_done',{voice_cache_hit:true,encode_provider:'render-cache'});return {bytes:new Uint8Array(cached),mime:'audio/mpeg',model:'cache',provider:'cache',cached:true,chars:text.length};}
 const stored=kv?.get?Number(await kv.get('voice:quota:until').catch(()=>0)):0;
 if(Math.max(cooldown,stored)>Date.now())throw Error('quota');
 if(!env.GEMINI_API_KEY)throw Error('voice_gemini_key_missing');
 const body=JSON.stringify({text,api_key:String(env.GEMINI_API_KEY||''),voice:'Achird',models:['gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts']});
 const headers=await reserveHeaders(env,hex(await crypto.subtle.digest('SHA-256',E.encode(body))),'synthesize');
 const endpoint='https://zevanory-product-control-edge.onrender.com/api/voice/synthesize';
 const started=Date.now();
 const r=await fetchImpl(endpoint,{method:'POST',headers:{...headers,'content-type':'application/json'},body,signal:AbortSignal.timeout(55000)});
 if(r.status===429){
  const error=await r.json().catch(()=>({}));if(error.error==='gemini_quota'){
   cooldown=Date.now()+Math.max(60,Number(r.headers.get('retry-after'))||60)*1000;
   await kv?.put?.('voice:quota:until',String(cooldown),{expirationTtl:Math.max(60,Math.ceil((cooldown-Date.now())/1000))}).catch(()=>{});
   await onStage('voice_quota',{voice_quota_reset_at:new Date(cooldown).toISOString()});throw Error('quota');
  }
  throw Error('voice_render_busy');
 }
 if(!r.ok)throw Error('voice_render_http_'+r.status);
 const bytes=new Uint8Array(await r.arrayBuffer());
 if(bytes.length<4||bytes.length>12*1024*1024||bytes[0]!==255||(bytes[1]&224)!==224)throw Error('voice_render_invalid_mp3');
 await kv?.put?.(cacheKey,bytes,{expirationTtl:TTL}).catch(()=>{});
 const model=r.headers.get('x-voice-model')||'gemini';
 await onStage('tts_done',{voice_cache_hit:false,tts_ms:Date.now()-started,encode_provider:'render',encode_bytes:bytes.length,voice_model:model});
 return {bytes,mime:'audio/mpeg',model,provider:'render-gemini',cached:false,chars:text.length};
}
export async function handleReserveEncodeAudit(request,env){
 const expected=String(env.CERTIFICATION_E2E_TOKEN||env.OPERATOR_TOKEN||''),supplied=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
 if(expected.length<24||supplied!==expected)return Response.json({error:'unauthorized'},{status:401});
 if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
 const digest=request.headers.get('x-voice-pcm-sha256')||'',rate=Number(request.headers.get('x-voice-sample-rate')||24000);
 if(!/^[a-f0-9]{64}$/.test(digest)||![8000,16000,24000,32000,48000].includes(rate))return Response.json({error:'invalid_fixture'},{status:400});
 // The runner hashes its fixed PCM. Render verifies that signed digest against
 // the streamed body; the Worker never decodes, copies or converts PCM.
 const headers=await reserveHeaders(env,digest,'encode',rate);
 const r=await fetch('https://zevanory-product-control-edge.onrender.com/api/voice/encode',{method:'POST',headers:{...headers,'content-type':'application/octet-stream','x-voice-sample-rate':String(rate)},body:request.body,signal:AbortSignal.timeout(55000)});
 return new Response(r.body,{status:r.status,headers:{'content-type':r.headers.get('content-type')||'application/json','cache-control':'no-store','x-voice-provider':'render'}});
}
