import lamejs from "./vendor/lame.min.mjs";
import { downsamplePcmMono, encodePcmRemotely } from "./voice-pcm.mjs";
const E=new TextEncoder(), FRAME=576, CORE=FRAME*20, WARM=FRAME*2, MAX=3*1024*1024;
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const replay=new Map();
export async function voiceSignedHeaders(bytes,rate,env,fields={}){
 const secret=String(env.ELITE_INTERNAL_TOKEN||"");if(secret.length<24)throw Error("voice_chunk_secret_missing");
 const timestamp=String(Date.now()),nonce=crypto.randomUUID(),digest=hex(await crypto.subtle.digest("SHA-256",bytes));
 const meta=JSON.stringify(fields),message=["zevanory-voice-chunk-v1",timestamp,nonce,rate,digest,meta].join("\n");
 const key=await crypto.subtle.importKey("raw",E.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return {"content-type":"application/octet-stream","x-voice-timestamp":timestamp,"x-voice-nonce":nonce,"x-voice-sample-rate":String(rate),"x-voice-meta":meta,"x-voice-signature":hex(await crypto.subtle.sign("HMAC",key,E.encode(message)))};
}
async function authenticated(request,bytes,env){
 const timestamp=request.headers.get("x-voice-timestamp"),nonce=request.headers.get("x-voice-nonce"),rate=request.headers.get("x-voice-sample-rate"),meta=request.headers.get("x-voice-meta")||"{}";
 if(!/^\d{13}$/.test(timestamp||"")||Math.abs(Date.now()-Number(timestamp))>60000||!/^[a-zA-Z0-9-]{16,80}$/.test(nonce||"")||meta.length>600)return false;
 const secret=String(env.ELITE_INTERNAL_TOKEN||"");if(secret.length<24)return false;
 const digest=hex(await crypto.subtle.digest("SHA-256",bytes)),message=["zevanory-voice-chunk-v1",timestamp,nonce,rate,digest,meta].join("\n"),sig=request.headers.get("x-voice-signature")||"";
 if(!/^[a-f0-9]{64}$/.test(sig))return false;
 const key=await crypto.subtle.importKey("raw",E.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
 if(!await crypto.subtle.verify("HMAC",key,Uint8Array.from(sig.match(/../g),x=>parseInt(x,16)),E.encode(message)))return false;
 for(const [k,at] of replay)if(at<Date.now()-60000)replay.delete(k);
 if(replay.has(nonce))return false;replay.set(nonce,Date.now());return true;
}
function frames(mp3){
 const out=[];let p=0;
 while(p+4<=mp3.length){
  const h=(mp3[p]<<24)|(mp3[p+1]<<16)|(mp3[p+2]<<8)|mp3[p+3];
  if((h>>>21)!==2047||((h>>>19)&3)!==0||((h>>>17)&3)!==1)throw Error("voice_chunk_mp3_header_invalid");
  const index=(h>>>12)&15,rateIndex=(h>>>10)&3,pad=(h>>>9)&1;
  const kbps=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160][index],rate=[11025,12000,8000][rateIndex];
  const length=Math.floor(72000*kbps/rate)+pad;
  if(!kbps||rate!==8000||p+length>mp3.length)throw Error("voice_chunk_mp3_frame_invalid");
  // Independent encoder frames must have no bit-reservoir dependency.
  if(mp3[p+4]!==0)throw Error("voice_chunk_mp3_reservoir_enabled");
  out.push(mp3.subarray(p,p+length));p+=length;
 }
 if(p!==mp3.length)throw Error("voice_chunk_mp3_trailing_bytes");return out;
}
function join(parts){const result=new Uint8Array(parts.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of parts){result.set(c,offset);offset+=c.length;}return result;}
export function encodeVoiceChunk(pcm,rate,meta){
 const reduced=downsamplePcmMono(pcm,rate,8000).pcm;
 const encoder=new lamejs.Mp3Encoder(1,8000,32),parts=[],samples=new Int16Array(reduced.buffer,reduced.byteOffset,reduced.length/2);
 for(let i=0;i<samples.length;i+=1152){const b=encoder.encodeBuffer(samples.subarray(i,i+1152));if(b.length)parts.push(new Uint8Array(b));}
 parts.push(new Uint8Array(encoder.flush()));
 const all=frames(join(parts)),count=Math.ceil(Number(meta.samples)/FRAME);
 if(!Number.isInteger(count)||count<1||count>20||all.length<3+count)throw Error("voice_chunk_frame_count_invalid");
 // LAME's 576-sample encoder delay follows 1152 samples of overlap.
 // Keep initial warmup/final flush only once for the complete MP3 stream.
 const first=meta.first===true,last=meta.last===true;
 return join(all.slice(first?0:3,last?undefined:3+count));
}
export async function handleVoiceChunk(request,env){
 if(request.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405});
 const length=Number(request.headers.get("content-length")||0);
 if(length>100000)return Response.json({error:"voice_chunk_size_invalid"},{status:413});
 const bytes=new Uint8Array(await request.arrayBuffer());
 if(!bytes.length||bytes.length>100000||bytes.length%2)return Response.json({error:"voice_chunk_size_invalid"},{status:413});
 if(!await authenticated(request,bytes,env))return Response.json({error:"voice_chunk_auth_required"},{status:401});
 const rate=Number(request.headers.get("x-voice-sample-rate")),meta=JSON.parse(request.headers.get("x-voice-meta")||"{}");
 if(![8000,16000,24000,32000,48000].includes(rate)||!Number.isInteger(meta.samples)||meta.samples<1||meta.samples>CORE||bytes.length!==(WARM+Math.ceil(meta.samples/FRAME)*FRAME+WARM)*(rate/8000)*2)return Response.json({error:"voice_chunk_format_invalid"},{status:400});
 const mp3=encodeVoiceChunk(bytes,rate,meta);
 console.log(JSON.stringify({voice_encode_chunk:true,audit_id:meta.audit_id,index:meta.index,attempt:meta.attempt,samples:meta.samples,mp3_bytes:mp3.length}));
 return new Response(mp3,{headers:{"content-type":"audio/mpeg","cache-control":"no-store"}});
}
export async function renderVoiceSecret(env){
 const key=await crypto.subtle.importKey("raw",E.encode(String(env.ELITE_INTERNAL_TOKEN||"")),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return hex(await crypto.subtle.sign("HMAC",key,E.encode("zevanory-render-voice-v1")));
}
export async function encodePcmInChunks(pcm,rate,env,fetchImpl=fetch,{auditId=crypto.randomUUID(),onStage=async()=>{}}={}){
 if(!(pcm instanceof Uint8Array)||!pcm.length||pcm.length>MAX||pcm.length%2||![8000,16000,24000,32000,48000].includes(rate))throw Error("voice_pcm_size_invalid");
 const sourceSamples=pcm.length/2,ratio=rate/8000,total=Math.floor(sourceSamples/ratio),parts=[],metrics=[];let calls=0;
 try{
  for(let start=0,index=0;start<total;start+=CORE,index++){
   const samples=Math.min(CORE,total-start),padded=Math.ceil(samples/FRAME)*FRAME,block=new Uint8Array((WARM+padded+WARM)*ratio*2);
   const begin=(start-WARM)*ratio,end=(start+padded+WARM)*ratio,a=Math.max(0,begin),b=Math.min(sourceSamples,end);
   block.set(pcm.subarray(a*2,b*2),(a-begin)*2);
   let completed=false;
   for(let attempt=0;attempt<3;attempt++){
    if(++calls>38)throw Error("voice_chunk_invocation_budget");
    const meta={audit_id:String(auditId).slice(0,80),index,attempt,samples,first:index===0,last:start+samples>=total};
    const headers=await voiceSignedHeaders(block,rate,env,meta);
    const request=new Request("https://zevanory.api.br/internal/voice/encode-chunk?audit_id="+encodeURIComponent(meta.audit_id)+"&chunk="+index+"&attempt="+attempt,{method:"POST",headers,body:block,signal:AbortSignal.timeout(15000)});
    const at=Date.now(),response=await fetchImpl(request);
    metrics.push({index,attempt,http:response.status,wall_ms:Date.now()-at,samples});
    if(response.ok){const bytes=new Uint8Array(await response.arrayBuffer());frames(bytes);parts.push(bytes);completed=true;break;}
    await response.body?.cancel();
    if(response.status!==503)throw Error("voice_chunk_http_"+response.status);
   }
   if(!completed)throw Error("voice_chunk_retries_exhausted");
  }
  return {bytes:join(parts),provider:"cloudflare-chunks",chunks:metrics,fallback_used:false};
 }catch(error){
  await onStage("encode_fallback",{encode_chunk_error:String(error.message).slice(0,200),encode_chunks:metrics});
  const bytes=await encodePcmRemotely(pcm,rate,{VOICE_ENCODE_URL:"https://zevanory-product-control-edge.onrender.com/api/voice/encode",VOICE_ENCODE_SECRET:await renderVoiceSecret(env)},fetchImpl);
  return {bytes,provider:"render",chunks:metrics,fallback_used:true,chunk_error:String(error.message).slice(0,200)};
 }
}

export async function handleVoiceEncodeAudit(request,env){
 const expected=String(env.CERTIFICATION_E2E_TOKEN||env.OPERATOR_TOKEN||"");
 const supplied=(request.headers.get("authorization")||"").replace(/^Bearer /,"");
 let diff=expected.length^supplied.length;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^(supplied.charCodeAt(i)||0);
 if(expected.length<24||diff)return Response.json({error:"unauthorized"},{status:401});
 if(request.method!=="POST")return Response.json({error:"method_not_allowed"},{status:405});
 if(Number(request.headers.get("content-length")||0)>MAX)return Response.json({error:"voice_pcm_size_invalid"},{status:413});
 const pcm=new Uint8Array(await request.arrayBuffer());if(pcm.length>MAX)return Response.json({error:"voice_pcm_size_invalid"},{status:413});
 const rate=Number(request.headers.get("x-voice-sample-rate")||24000),auditId=new URL(request.url).searchParams.get("audit_id")||crypto.randomUUID();
 try{const encoded=await encodePcmInChunks(pcm,rate,env,fetch,{auditId});
  return new Response(encoded.bytes,{headers:{"content-type":"audio/mpeg","cache-control":"no-store","x-voice-provider":encoded.provider,"x-voice-fallback-used":String(encoded.fallback_used),"x-voice-chunks":JSON.stringify(encoded.chunks)}});
 }catch(error){return Response.json({error:String(error.message).slice(0,300)},{status:502});}
}
