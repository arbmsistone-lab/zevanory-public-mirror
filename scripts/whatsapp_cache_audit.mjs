import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {catalogVoices} from './voice_cache_warm.mjs';
import {voiceCacheKey} from '../worker/voice-remote-tts.mjs';
import {voiceQuality} from './voice_audit_quality.mjs';
import {readFinalClosure} from './voice_final_closure_read.mjs';
const dir='/tmp/voice-audit';mkdirSync(dir,{recursive:true});
const origin='https://zevanory.api.br',results=[];
const save=()=>writeFileSync(dir+'/cache-audit.json',JSON.stringify({architecture:'render-gemini+cache',new_synthesis_requests:0,results},null,2));
async function op(body,id){
 const r=await fetch(origin+'/api/admin/whatsapp-onboard/delivery-proof?audit_id='+encodeURIComponent(id),{method:'POST',headers:{authorization:'Bearer '+process.env.OPERATOR_TOKEN,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const raw=await r.text();let j;try{j=JSON.parse(raw);}catch{throw Error(`${id}:http_${r.status}:non_json`);}
 if(!r.ok)throw Error(`${id}:http_${r.status}:${j.error||'unknown'}`);return j;
}
try{
 const seen=new Set();
 for(const entry of catalogVoices()){
  const key=await voiceCacheKey(entry.text);if(seen.has(key))continue;seen.add(key);
  const id='cache-'+crypto.randomUUID();
  const cached=await op({operation:'audit-cache',question:entry.question},id);
  if(cached.skipped){results.push({key,id,skipped:true,cause:cached.warning});console.log('::warning title=VOICE_CACHE_MISS::'+entry.product+'/'+entry.intent+' skipped; synthesis prohibited');save();continue;}
  if(cached.voice_cached!==true||cached.voice_provider!=='cache'||cached.key!==key||cached.text!==entry.text)throw Error(id+':cache_contract_failed');
  const transcribed=await op({operation:'audit-transcribe',audio_base64:cached.audio_base64},'whisper-'+id);
  const quality=voiceQuality(entry.text,transcribed.transcript);
  results.push({key,id,voice_cached:true,text:entry.text,transcript:transcribed.transcript,...quality});save();
  if(!quality.pass)throw Error(`${id}:WER_${quality.wer}:numbers_identical_${quality.numbers_identical}`);
 }
 writeFileSync(dir+'/final-closure.json',JSON.stringify(await readFinalClosure(),null,2));
 // Tail is live before requests. Allow delivery of the final telemetry event.
 await new Promise(r=>setTimeout(r,8000));
 const raw=readFileSync('/tmp/audit-tail.json','utf8'),events=[];
 let pos=0;
 while(pos<raw.length){const start=raw.indexOf('{',pos);if(start<0)break;let matched=false;for(let end=start+1;end<=raw.length;end++){if(raw[end-1]!=='}')continue;try{const e=JSON.parse(raw.slice(start,end));events.push(e);pos=end;matched=true;break;}catch{}}if(!matched)break;}
 for(const result of results.filter(x=>!x.skipped)){
  const found=events.filter(e=>{try{return new URL(e.event?.request?.url).searchParams.get('audit_id')===result.id;}catch{return false;}});
  if(found.length!==1||typeof found[0].cpuTime!=='number')throw Error(result.id+':correlated_cpu_required');
  result.cpuTime=found[0].cpuTime;result.outcome=found[0].outcome;save();
  if(result.cpuTime>=50||result.outcome!=='ok')throw Error(`${result.id}:cpu_${result.cpuTime}:outcome_${result.outcome}`);
 }
 console.log(JSON.stringify({pass:true,checked:results.filter(x=>!x.skipped).length,skipped:results.filter(x=>x.skipped).length,new_synthesis_requests:0}));
}catch(error){save();console.error('::error title=WHATSAPP_CACHE_AUDIT::'+String(error.message).replace(/\n/g,' '));process.exitCode=1;}
