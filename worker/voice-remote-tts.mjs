// Text-only, signed synthesis on Render. PCM never enters the production reply path.
import {renderTextTts,voiceReserveSecret} from './voice-render-client.mjs';
export {voiceCacheKey} from './voice-render-client.mjs';
export const SYNTH_URL='https://zevanory-product-control-edge.onrender.com/api/voice/synthesize';
export const SYNTH_MODELS=['gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts'];
export async function synthesizeVoice(text,{apiKey,env={},kv=null,fetchImpl=fetch,secret=null,onStage=async()=>{}}={}){
 return renderTextTts(String(text||'').trim(),{...env,GEMINI_API_KEY:apiKey,...(secret?{VOICE_ENCODE_SECRET:secret}:{})},fetchImpl,{kv,onStage});
}
