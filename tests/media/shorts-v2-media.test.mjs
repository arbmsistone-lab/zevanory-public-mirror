import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as mod from '../../scripts/shorts-v2/core.mjs';
import {recordMusicPublication} from '../../scripts/shorts-v2/music-publications.mjs';
import {planSlot,publishShort,TARGET_CHANNEL} from '../../scripts/channels/youtube-daily-short.mjs';
import * as renderer from '../../scripts/shorts-v2/render.mjs';
import {killedMutation} from '../helpers/f1-mutation.mjs';
import {kvFixture} from '../helpers/shorts-curation-kv.mjs';
import {STATE_KEY} from '../../scripts/shorts-v2/music-kv.mjs';
import {readTextNormalized} from '../helpers/text.mjs';
const source=new URL('../../scripts/shorts-v2/core.mjs',import.meta.url),renderSource=new URL('../../scripts/shorts-v2/render.mjs',import.meta.url),manifest=JSON.parse(await readFile(new URL('../../data/musica-licencas.json',import.meta.url),'utf8'));
const approved={modelo:'gemini-3.8-flash-tts',voz_fixa:'Achird',comparacao_aprovada:true,nivel_gratuito_confirmado:true,publicacao_aprovada:true};
async function mixProof(m){const dir=await mkdtemp(join(tmpdir(),'zev-v2-mix-'));try{renderer.command('ffmpeg',['-y','-f','lavfi','-i','sine=frequency=330:sample_rate=24000:duration=4','-af','volume=2',dir+'/voice.wav']);renderer.command('ffmpeg',['-y','-i',dir+'/voice.wav','-i',new URL('../../assets/musica/ia-1.ogg',import.meta.url).pathname,'-filter_complex',m.mixGraph(4),'-map','[mix]','-t','4',dir+'/mix.wav','-map','[reference]','-t','4',dir+'/reference.wav','-map','[stem]','-t','4',dir+'/stem.wav']);const raw=f=>renderer.command('ffmpeg',['-v','error','-i',f,'-f','f32le','-ar','24000','-ac','1','pipe:1'],{buffer:true});const windows=[{start:1,end:2.5}],ref=renderer.rmsDb(raw(dir+'/reference.wav'),windows),duck=renderer.rmsDb(raw(dir+'/stem.wav'),windows);assert.ok(ref-duck>=10,'measured sidechain reduction');}finally{await rm(dir,{recursive:true,force:true});}}
test('V2: FFmpeg sidechain actually attenuates music by at least 10 dB',()=>mixProof(renderer));
test('V2 mutant: actual sidechain removed',()=>killedMutation(renderSource,[["sidechaincompress=threshold=0.06:ratio=12:attack=10:release=250:makeup=1","amix=inputs=2:normalize=0"]],mixProof));
async function renderProof(m,{reason=null,retain=false,stateKv=null,expectedMusic=null,handoff=null}={}){
 const dir=await mkdtemp(join(tmpdir(),'zev-v2-render-'));
 try{
  const p=mod.planV2(planSlot('2026-11-11','dica',{hotmartOpen:true})),tokens=p.speech.split(/\s+/),duration=28;
  const words=tokens.map((word,i)=>({word,start:i<tokens.length-7?i*(duration-2.5)/(tokens.length-7):duration-2.5+(i-(tokens.length-7))*2.5/7,end:i<tokens.length-7?(i+1)*(duration-2.5)/(tokens.length-7)-.025:duration-2.5+(i-(tokens.length-7)+1)*2.5/7-.025}));
  const pcm=Buffer.alloc(24000*duration*2);
  for(let i=0;i<pcm.length/2;i++){const t=i/24000,word=words.find(w=>t>=w.start&&t<=w.end),v=word?.16*Math.sin(t*2*Math.PI*220):0;pcm.writeInt16LE(Math.round(v*32767),i*2);}
  let out,error;
  try{out=await m.renderV2(p,dir+'/short',{preview:true,config:approved,stateKv:stateKv||{get:async()=>null,put:async()=>{throw Error('preview must not write KV');}},synthesize:async()=>({pcm,voice:'Achird',model:approved.modelo}),align:async()=>({segments:[{words}]})});}catch(e){error=e;}
  if(reason){assert.match(error?.message||'',new RegExp(reason));return;}
  assert.equal(error,undefined,'normal render must pass measured QC');
  assert.equal(out.qc.score,100);assert.ok(out.qc.metrics.duckingDb>=10);assert.ok(out.qc.metrics.voiceMusicDb>=12);assert.ok(out.qc.metrics.musicDetected);
  assert.ok(out.qc.metrics.hookFont>=96);assert.ok(out.qc.metrics.sceneCuts.length>=9);
  const graph=await readFile(dir+'/short-filter.txt','utf8');assert.match(graph,/zoompan=/);assert.match(graph,/1724/);assert.match(graph,/Inter-ExtraBold/);
  assert.ok((await readFile(dir+'/short-contato.png')).length>10000);assert.equal(JSON.parse(await readFile(dir+'/short-qc.json','utf8')).mode,'preview');
  if(expectedMusic)assert.equal(JSON.parse(await readFile(dir+'/short-licenca.json','utf8')).arquivo,expectedMusic);
  if(handoff)out.publication=await handoff(out,p);
  if(retain)console.log('PREVIEW_PATH='+dir+'/short.mp4');
  return out;
 }finally{if(!retain)await rm(dir,{recursive:true,force:true});}
}
test('NC03/04: branded offline render measures ASS, final MP4 cuts, hook and contact sheet',()=>renderProof(renderer,{retain:process.env.KEEP_SHORT_PREVIEW==='1'}));
// These mutate the actual render source. Relative asset URLs must still resolve
// from its real directory; no substituted metric enters quality().
async function renderMutation(from,to,reason){
 const source=readTextNormalized(renderSource);assert.equal(source.split(from).length-1,1);
 const file=new URL('./render-mutant-'+Math.random().toString(16).slice(2)+'.mjs',renderSource);
 try{
  await writeFile(file,source.replace(from,to));const m=await import(file.href);
  await renderProof(m,{reason});
 }finally{await rm(file,{force:true});}
}
test('NC03 render mutant: subtitle moved to y1800 is rejected from serialized ASS',()=>renderMutation("captions(words)","captions(words).replaceAll('pos(500,1530)','pos(500,1800)')",'caption_safe_area'));
test('NC03 render mutant: five-second cuts rejected by final MP4 scene detector',()=>renderMutation('sceneSpan=duration/sceneCount','sceneSpan=5','visual_rhythm'));
test('NC04 render mutant: 58px hook rejected from actual filter',()=>renderMutation("plan.sentences[0],96,'white'","plan.sentences[0],58,'white'",'hook'));

test('NC01: all actual music excerpts fit 40 seconds and combined 6 MB budget',async()=>{let total=0;for(const row of manifest.faixas){const path=new URL('../../'+row.arquivo,import.meta.url).pathname;total+=(await readFile(path)).length;const probe=JSON.parse(renderer.command('ffprobe',['-v','error','-show_format','-of','json',path]));assert.ok(Number(probe.format.duration)>0&&Number(probe.format.duration)<=40);}assert.ok(total<=6000000);assert.equal(manifest.faixas.length,2);});

test('NC09 render mutant: light caption band fails measured MP4 contrast',()=>renderMutation('drawbox=x=60:y=1410:w=920:h=210:color=0x0b0f16','drawbox=x=60:y=1410:w=920:h=210:color=0xffffff','caption_contrast'));
test('NC10 render mutant: music at minus 40 LUFS fails audible balance',()=>renderMutation('loudnorm=I=-23:TP=-4','loudnorm=I=-40:TP=-4','voice_music_balance'));

test('NC16 media: full MP4 renders with verified promoted KV audio',async()=>{const f=await kvFixture();await renderProof(renderer,{stateKv:f.kv,expectedMusic:f.row.arquivo});});
test('NC16 media: unreadable optional state still renders, uploads through actual publisher and records public receipt offline',async()=>{
 const f=await kvFixture();f.data.set(STATE_KEY,'{');let uploads=0;
 const out=await renderProof(renderer,{stateKv:f.kv,handoff:async(video,plan)=>{
  const result=await publishShort(plan,await readFile(video.file),{accessToken:'synthetic',sleep:async()=>{},fetchImpl:async(url,options={})=>{
   if(url.includes('/channels?'))return Response.json({items:[{id:TARGET_CHANNEL}]});
   if(url.includes('uploadType=resumable'))return new Response('',{headers:{location:'https://upload.example.test/session'}});
   if(url==='https://upload.example.test/session'){uploads++;assert.ok(options.body.length>10000);return Response.json({id:'KVTEST123'});}
   if(url.includes('/videos?'))return Response.json({items:[{status:{uploadStatus:'processed',privacyStatus:'public'},processingDetails:{processingStatus:'succeeded'}}]});
   throw Error('unexpected offline route');
  }});await recordMusicPublication(f.kv,plan,result,video.track);return result;
 }});
 assert.equal(out.publication.privacy_status,'public');assert.equal(uploads,1);assert.ok([...f.data.keys()].some(k=>k.startsWith('zpc:shorts:v2:musica:publicado:')));assert.ok([...f.data.values()].some(v=>v.includes('music_kv_state_unreadable_using_repository')));
});

// Duas passagens reais do FFmpeg: um mix bem abaixo do alvo chega a -14±1 LUFS com TP<=-1 (critério de quality()).
test('V2: loudnorm em duas passagens atinge -14±1 LUFS e TP<=-1 em fala com pausas', async () => {
 const dir=await mkdtemp(join(tmpdir(),'zev-v2-ln-'));
 try{
  renderer.command('ffmpeg',['-y','-f','lavfi','-i',"aevalsrc='0.05*sin(2*PI*220*t)*gt(mod(t,3),1.2)':s=24000:d=28",dir+'/quiet.wav']);
  renderer.normalizeTwoPass(dir+'/quiet.wav',dir+'/norm.wav');
  const m=renderer.audioMetrics(dir+'/norm.wav');
  assert.ok(Math.abs(m.lufs+14)<=1,'LUFS integrado '+m.lufs);
  assert.ok(m.peak<=-1,'true peak '+m.peak);
 }finally{await rm(dir,{recursive:true,force:true});}
});
