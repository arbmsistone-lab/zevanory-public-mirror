import { downsamplePcmMono } from "./voice-pcm.mjs";
import { encodePcmInChunks, renderVoiceSecret } from "./voice-chunks.mjs";
import { Buffer } from "node:buffer";
const decoder=new TextDecoder();
export async function handleVoiceAudit(input,env){
 if(input.operation==="audit-encode"){
  const b64=String(input.pcm_base64||"");
  if(!b64||b64.length>4000000||Number(input.sample_rate)!==24000)return Response.json({error:"audit_pcm_invalid"},{status:400});
  const pcm=new Uint8Array(Buffer.from(b64,"base64"));
  if(pcm.length>3000000||pcm.length%2)return Response.json({error:"audit_pcm_invalid"},{status:400});
  const encoded=await encodePcmInChunks(pcm,24000,env,fetch,{auditId:input.audit_id});
  const mp3=encoded.bytes;
  let binary="";for(let i=0;i<mp3.length;i+=8192)binary+=String.fromCharCode(...mp3.subarray(i,i+8192));
  return Response.json({ok:true,audit_id:String(input.audit_id||"").slice(0,100),source_rate:24000,sample_rate:8000,source_bytes:pcm.length,source_seconds:pcm.length/48000,encode_bytes:mp3.length,encode_provider:encoded.provider,chunks:encoded.chunks,fallback_used:encoded.fallback_used,audio_base64:btoa(binary)});
 }
 if(input.operation==="audit-source"){
  if(!env.GEMINI_API_KEY||env.GEMINI_FREE_TIER_CONFIRMED!=="true")return Response.json({error:"free_gemini_key_missing"},{status:503});
  const text=String(input.text||"");if(text.length<100||text.length>650)return Response.json({error:"audit_source_text_invalid"},{status:400});
  const attempts=[];
  for(const model of ["gemini-3.8-flash-tts","gemini-3.8-flash-lite-tts"]){
   try{
    const response=await fetch("https://generativelanguage.googleapis.com/v1beta/interactions",{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},body:JSON.stringify({model,input:[{type:"user_input",content:[{type:"text",text,annotations:[{type:"speech_metadata",style:"Fale em português do Brasil, com clareza e ritmo de conversa."}]}]}],response_format:{type:"audio",mime_type:"audio/l16",sample_rate:8000},generation_config:{speech_config:[{voice:"Achird"}]}}),signal:AbortSignal.timeout(15000)});
    const body=await response.json();attempts.push({model,http:response.status,error_code:body.error?.code,error_status:body.error?.status,error_message:String(body.error?.message||"").split(String(env.GEMINI_API_KEY)).join("[redacted]").slice(0,500),retry_after:response.headers.get("retry-after")});const audio=(body.steps||[]).filter(s=>s.type==="model_output").flatMap(s=>s.content||[]).find(x=>x.type==="audio"&&x.data);
    if(response.ok&&audio)return Response.json({ok:true,model,attempts,pcm_base64:audio.data,sample_rate:Number(audio.sample_rate||(String(audio.mime_type||"").match(/rate=(\d+)/)||[])[1])||24000});
   }catch(error){attempts.push({model,error_name:String(error?.name||"Error")});}
  }
  return Response.json({error:"audit_source_tts_failed",attempts},{status:502});
 }
 if(input.operation==="audit-encoder-key"){
  const publicKey=await crypto.subtle.importKey("jwk",input.public_key,{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);
  const wrapped=await crypto.subtle.encrypt({name:"RSA-OAEP"},publicKey,new TextEncoder().encode(await renderVoiceSecret(env)));
  return Response.json({wrapped_key:Buffer.from(wrapped).toString("base64")});
 }
 if(input.operation==="audit-transcribe"){
  const b64=String(input.audio_base64||"");
  if(!b64||b64.length>1500000)return Response.json({error:"audit_audio_invalid"},{status:400});
  const ai=env.AI||env.ZEVANORY_AI;
  if(!ai?.run)return Response.json({error:"audit_ai_binding_missing"},{status:503});
  try{const result=await ai.run("@cf/openai/whisper-large-v3-turbo",{audio:b64,task:"transcribe",language:"pt"});return Response.json({ok:true,model:"@cf/openai/whisper-large-v3-turbo",transcript:String(result?.text||result?.transcription_info?.text||"").slice(0,5000)});}catch(error){return Response.json({error:"audit_whisper_failed",name:String(error?.name||"Error")},{status:502});}
 }
 return null;
}
export async function saveWhatsappObservation(kv,item,question,reply,status,extra={}){
 if(!kv?.put||!item.message_id)return;
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(item.from||"")));
 const hash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");
 const observation={inbound_message_id:item.message_id,inbound_type:item.type,at:status.at,contact_hash:hash,transcript:String(question||"").slice(0,5000),reply_text:String(reply.body||"").slice(0,4000),...status,...extra};
 await kv.put("whatsapp:observation:"+item.message_id,JSON.stringify(observation),{expirationTtl:86400});
}
