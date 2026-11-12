import {tts} from './render.mjs';
export function assertSamplesMode(slot,dryRun){if(slot!=='amostras'||dryRun!=='true')throw Error('samples_require_dry_run');}
export async function sampleTts(text,voice,key,{fetchImpl=fetch,...options}={}){
 let code=null;
 try{return await tts(text,voice,key,{...options,fetchImpl:async(...args)=>{const r=await fetchImpl(...args);if(!r.ok)code=String(r.status);if(r.clone){const body=await r.clone().json().catch(()=>null);if(body?.error&&/billing|faturamento|payment|paid|quota/i.test(JSON.stringify(body.error)))code=String(body.error.status||body.error.code||r.status);}return r;}});}catch(e){const error=Error('GEMINI::'+(code||'UNAVAILABLE'));error.geminiCode=code||'UNAVAILABLE';throw error;}
}
export function validateSamplesWorkflow(text){
 const short=text.split('  short:')[1]?.split('  voice_samples:')[0],samples=text.split('  voice_samples:')[1];
 if(!short?.includes("inputs.slot != 'amostras'")||!samples||!samples.includes('compare-voices.mjs --samples')||!samples.includes("inputs.dry_run")||/youtube-daily-short|short-crosspost|CLOUDFLARE|KV_NAMESPACE|YOUTUBE_|renderV2|publishShort/.test(samples))throw Error('samples_publish_isolation');return true;
}
