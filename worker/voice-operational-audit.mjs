import { downsamplePcmMono } from "./voice-pcm.mjs";
import { pcm16ToMp3 } from "./voice-provider-router.mjs";
const decoder=new TextDecoder();
export async function handleVoiceAudit(input,env){
 if(input.operation==="audit-encode"){
  const b64=String(input.pcm_base64||"");
  if(!b64||b64.length>4000000||Number(input.sample_rate)!==24000)return Response.json({error:"audit_pcm_invalid"},{status:400});
  const pcm=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  if(pcm.length>3000000||pcm.length%2)return Response.json({error:"audit_pcm_invalid"},{status:400});
  const reduced=downsamplePcmMono(pcm,24000,8000);
  const mp3=pcm16ToMp3(reduced.pcm,reduced.sampleRate,32);
  let binary="";for(let i=0;i<mp3.length;i+=8192)binary+=String.fromCharCode(...mp3.subarray(i,i+8192));
  return Response.json({ok:true,audit_id:String(input.audit_id||"").slice(0,100),source_rate:24000,sample_rate:8000,source_bytes:pcm.length,source_seconds:pcm.length/48000,encode_bytes:mp3.length,audio_base64:btoa(binary)});
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
