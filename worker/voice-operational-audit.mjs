import { renderVoiceSecret } from "./voice-chunks.mjs";
import { Buffer } from "node:buffer";
import { synthesizeVoice, voiceCacheKey } from "./voice-remote-tts.mjs";
import { deterministicReply, speechText } from "./whatsapp-conversation.mjs";
import { answerSupportQuestion } from "./support-knowledge.mjs";
export async function handleVoiceAudit(input,env){
 if(input.operation==="audit-cache"){
  const question=String(input.question||"").slice(0,400);
  const known=answerSupportQuestion({question});
  if(!known.answered||!["price","delivery","refund"].includes(known.intent))return Response.json({error:"audit_catalog_question_required"},{status:400});
  const text=speechText(deterministicReply(question).body);
  try{
   const result=await synthesizeVoice(text,{kv:env.ZEVANORY_PRIVATE_ARTIFACTS,cacheOnly:true});
   return Response.json({ok:true,voice_cached:true,voice_provider:result.provider,text,key:await voiceCacheKey(text),audio_base64:Buffer.from(result.bytes).toString("base64")});
  }catch(error){
   if(error.message==="voice_cache_miss")return Response.json({ok:true,skipped:true,warning:"voice_cache_miss",new_synthesis_requests:0});
   throw error;
  }
 }
 // Retired audit operations cannot consume Gemini quota or run Worker encoding.
 if(["audit-source","audit-encode"].includes(input.operation))return Response.json({error:"audit_legacy_retired_use_cache"},{status:410});
 if(input.operation==="audit-encoder-key"){
  const publicKey=await crypto.subtle.importKey("jwk",input.public_key,{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);
  const wrapped=await crypto.subtle.encrypt({name:"RSA-OAEP"},publicKey,new TextEncoder().encode(await renderVoiceSecret(env)));
  let wrappedGemini=null;
  if(input.include_gemini===true){
   if(!env.GEMINI_API_KEY||env.GEMINI_FREE_TIER_CONFIRMED!=="true")return Response.json({error:"validated_free_gemini_key_required"},{status:503});
   wrappedGemini=Buffer.from(await crypto.subtle.encrypt({name:"RSA-OAEP"},publicKey,new TextEncoder().encode(env.GEMINI_API_KEY))).toString("base64");
  }
  return Response.json({wrapped_key:Buffer.from(wrapped).toString("base64"),...(wrappedGemini?{wrapped_gemini_key:wrappedGemini}:{})});
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
