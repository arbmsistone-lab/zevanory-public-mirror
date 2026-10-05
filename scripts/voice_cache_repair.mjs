// Repair an exact spoken style prefix only. No Gemini endpoint or key is used.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {catalogVoices,cloudKv} from './voice_cache_warm.mjs';
import {voiceCacheKey} from '../worker/voice-remote-tts.mjs';
import {voiceQuality,tokens} from './voice_audit_quality.mjs';
const dir='/tmp/voice-repair';mkdirSync(dir,{recursive:true});
const report={new_synthesis_requests:0,entries:[]};
const save=()=>writeFileSync(dir+'/summary.json',JSON.stringify(report,null,2));
const style='Fale em português do Brasil, com voz natural, acolhedora, clara e profissional, em ritmo de conversa.';
async function transcribe(audio){
 const r=await fetch('https://zevanory.api.br/api/admin/whatsapp-onboard/delivery-proof',{method:'POST',headers:{authorization:'Bearer '+process.env.OPERATOR_TOKEN,'content-type':'application/json'},body:JSON.stringify({operation:'audit-transcribe',audio_base64:Buffer.from(audio).toString('base64')}),signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error('whisper_http_'+r.status);return r.json();
}
try{
 const kv=await cloudKv(process.env),seen=new Set();
 for(const entry of catalogVoices()){
  const key=await voiceCacheKey(entry.text);if(seen.has(key))continue;seen.add(key);
  const rec={key,text:entry.text};report.entries.push(rec);save();
  const original=await kv.get(key);
  if(!original){rec.skipped='cache_miss';console.log('::warning::'+key+' missing; synthesis prohibited');save();continue;}
  const before=await transcribe(original);rec.before={transcript:before.transcript,...voiceQuality(entry.text,before.transcript)};
  if(rec.before.pass){rec.skipped='already_valid';save();continue;}
  const actual=tokens(before.transcript),prefix=tokens(style);
  if(JSON.stringify(actual.slice(0,prefix.length))!==JSON.stringify(prefix))throw Error(key+':unexpected_audio_preserved');
  const words=(before.segments||[]).flatMap(s=>s.words||[]).flatMap(w=>tokens(w.word||w.text).map(token=>({token,start:w.start,end:w.end})));
  const wanted=tokens(entry.text).slice(0,3);let boundary=null;
  for(let i=prefix.length;i<words.length-2;i++)if(JSON.stringify(words.slice(i,i+3).map(w=>w.token))===JSON.stringify(wanted)){boundary=Number(words[i].start);break;}
  if(boundary===null){const segment=(before.segments||[]).find(s=>JSON.stringify(tokens(s.text).slice(0,3))===JSON.stringify(wanted));if(segment)boundary=Number(segment.start);}
  if(!(boundary>0))throw Error(key+':whisper_word_alignment_required_original_preserved');
  const name=String(report.entries.length),src=dir+'/'+name+'-original.mp3',dst=dir+'/'+name+'-repaired.mp3';
  writeFileSync(src,Buffer.from(original));
  // Preserve a bounded silent lead; timestamps are approximate and short initials
  // can be misrecognized when audio begins immediately at the first phoneme.
  rec.candidates=[];let accepted=null;
  for(const lead of [0.45,0.70,0.24]){
   const trim=Math.max(0,boundary-lead);
   execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',src,'-ss',String(trim),'-c:a','libmp3lame','-b:a','64k',dst]);
   const bytes=readFileSync(dst),after=await transcribe(bytes),quality=voiceQuality(entry.text,after.transcript);
   rec.candidates.push({trim_seconds:trim,transcript:after.transcript,...quality});save();
   if(quality.pass){accepted=bytes;rec.after=rec.candidates.at(-1);break;}
  }
  if(!accepted)throw Error(key+':repair_quality_failed_original_preserved');
  await kv.put(key,accepted,{expirationTtl:30*86400});rec.recorded=true;save();
  console.log(JSON.stringify(rec));
 }
 report.pass=true;save();
}catch(error){report.cause=error.message;save();console.error('::error title=CACHE_REPAIR::'+error.message);process.exitCode=1;}
