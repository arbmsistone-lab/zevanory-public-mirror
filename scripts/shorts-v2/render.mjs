import PROFILE from '../../data/musica-perfil.json' with {type:'json'};
import BASE_STATE from '../../data/musica-curadoria.json' with {type:'json'};
import {runtimeLibrary,writeMusicReport} from './music-kv.mjs';
import {sceneTimeline} from './scenes.mjs';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {scriptHistory} from './script-history.mjs';
import {musicPublications,lastPublishedMusic} from './music-publications.mjs';
import {visualMetrics,contactSheet} from './visual.mjs';
import {STYLE,CTA,assertVoice,licensedTrack,alignedWords,captions,quality,musicHistory} from './core.mjs';
export function command(cmd,args,{buffer=false}={}){const p=spawnSync(cmd,args,{encoding:buffer?null:'utf8',maxBuffer:128*1024*1024});if(p.status!==0)throw Error('media_tool_failed:'+cmd);return buffer?p.stdout:String(p.stdout||'')+String(p.stderr||'');}
export function ttsRequest(text,voice,model){
 if(!['gemini-3.8-flash-tts','gemini-2.5-flash-preview-tts'].includes(model))throw Error('tts_model_unsupported');
 const modern=model==='gemini-3.8-flash-tts';
 return {modern,url:modern?'https://generativelanguage.googleapis.com/v1beta/interactions':`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,body:modern
 ?{model,input:[{type:'user_input',content:[{type:'text',text,annotations:[{type:'speech_metadata',style:STYLE}]}]}],response_format:{type:'audio',mime_type:'audio/l16',sample_rate:24000},generation_config:{speech_config:[{voice}]}}
 :{contents:[{parts:[{text:STYLE+'\n\n'+text}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}}}}};
}
export async function tts(text,voice,key,{model,fetchImpl=fetch,freeTierConfirmed=false}={}){
 if(!key||!freeTierConfirmed)throw Error('free_tts_not_confirmed');
 const request=ttsRequest(text,voice,model);
 const r=await fetchImpl(request.url,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify(request.body),signal:AbortSignal.timeout(60000)}).catch(()=>{throw Error('free_tts_network_failed');});
 if(!r.ok)throw Error('free_tts_unavailable');
 const body=await r.json().catch(()=>{throw Error('tts_response_invalid');});
 const part=request.modern?(body.steps||[]).filter(x=>x.type==='model_output').flatMap(x=>x.content||[]).find(x=>x.type==='audio'&&x.data):body.candidates?.[0]?.content?.parts?.find(x=>x.inlineData?.data);
 const data=part?.data||part?.inlineData?.data,mime=part?.mime_type||part?.inlineData?.mimeType||'';
 if(!data||!/audio\/(l16|pcm)/i.test(mime))throw Error('tts_pcm_invalid');
 const rate=Number(part?.sample_rate||/rate=(\d+)/.exec(mime)?.[1]||24000);
 const pcm=Buffer.from(data,'base64');if(rate!==24000||!pcm.length||pcm.length%2)throw Error('tts_rate_invalid');
 return {pcm,voice,model};
}
export function audioMetrics(file){const out=command('ffmpeg',['-hide_banner','-nostats','-i',file,'-vn','-af','ebur128=peak=true,silencedetect=n=-35dB:d=0.05','-f','null','-']);const lufs=Number([...out.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1]),peak=Number([...out.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].at(-1)?.[1]);const starts=[...out.matchAll(/silence_start: ([\d.]+)/g)].map(m=>+m[1]),ends=[...out.matchAll(/silence_end: ([\d.]+)/g)].map(m=>+m[1]);return {lufs,peak,starts,ends};}
function pcm(file){return command('ffmpeg',['-v','error','-i',file,'-f','f32le','-ac','1','-ar','24000','pipe:1'],{buffer:true});}
export function rmsDb(bytes,windows){let sum=0,n=0;for(const w of windows){for(let i=Math.max(0,Math.ceil(w.start*24000));i<Math.min(bytes.length/4,Math.floor(w.end*24000));i++){const v=bytes.readFloatLE(i*4);sum+=v*v;n++;}}return n&&sum>0?10*Math.log10(sum/n):-Infinity;}
export function mixGraph(duration){return `[0:a]apad=whole_dur=${duration},asplit=2[voice][side];[1:a]loudnorm=I=-23:TP=-4:LRA=7,afade=t=in:d=0.5,afade=t=out:st=${duration-1.5}:d=1.5,asplit=2[reference][bed];[bed][side]sidechaincompress=threshold=0.06:ratio=12:attack=10:release=250:makeup=1,asplit=2[ducked][stem];[voice][ducked]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=7[mix]`;}
export async function renderV2(plan,base,{geminiKey,preview=false,stateKv,config:injectedConfig,align,synthesize=tts,note=(level,message)=>console.warn(message)}={}){
 if(plan.v2!==true)throw Error('v2_plan_required');
 const config=injectedConfig||JSON.parse(await readFile(new URL('../../data/shorts-padrao-v2.json',import.meta.url),'utf8'));
 assertVoice(config,config.voz_fixa,{preview});
 if(!stateKv?.get||!stateKv?.put)throw Error('music_history_unavailable');
 await scriptHistory(stateKv,plan,{reserve:!preview});
 const manifest=JSON.parse(await readFile(new URL('../../data/musica-licencas.json',import.meta.url),'utf8'));
 const library=await runtimeLibrary({kv:stateKv,manifest,profile:PROFILE,baseState:BASE_STATE,note});
 if(library.warnings.length){try{await writeMusicReport(stateKv,library.profile,library.state,plan.day,library.warnings);}catch{note('warning','SHORT_MUSIC report_write_failed');}}
 const last=await musicHistory(stateKv,plan.day,{repair:!preview});
 const musicPublished=await musicPublications(stateKv,plan.day);
 const rawAttempt=await stateKv.get('zpc:shorts:v2:musica:receipt:'+plan.day+':'+plan.slot),attempt=rawAttempt===null?null:JSON.parse(rawAttempt);
 if(attempt&&(!/^assets\/musica\/[a-z0-9-]+\.ogg$/.test(attempt.arquivo)||!Number.isSafeInteger(attempt.em)||attempt.em<=0))throw Error('music_attempt_unreadable');
 const track=await licensedTrack({theme:plan.theme,last:lastPublishedMusic(musicPublished,last,attempt),manifest:library.manifest,profile:library.profile,state:library.state,buffers:library.buffers,history:musicPublished});
 plan.description+='\nzevanory-music-key:'+track.arquivo+':'+track.sha256;
 if(track.credito&&!plan.description.includes(track.credito))plan.description+='\nMúsica: '+track.credito;
 // Reserving the chosen bed before any render avoids immediate repetition after failure.
 if(!preview){const receipt=JSON.stringify({arquivo:track.arquivo,em:Date.now()});await stateKv.put('zpc:shorts:v2:musica:receipt:'+plan.day+':'+plan.slot,receipt);await stateKv.put('zpc:shorts:v2:musica:last',receipt);}
 await mkdir(dirname(base),{recursive:true});
 const generated=await synthesize(plan.speech,config.voz_fixa,geminiKey,{model:config.modelo,freeTierConfirmed:config.nivel_gratuito_confirmado});
 if(!generated.model)throw Error('tts_model_unreported');assertVoice(config,generated.voice,{preview,model:generated.model});const pcmBytes=generated.pcm;
 await writeFile(base+'.pcm',pcmBytes);await writeFile(base+'-roteiro.txt',plan.speech);
 let sourceClipping=false;for(let i=0;i+1<pcmBytes.length;i+=2)if(Math.abs(pcmBytes.readInt16LE(i))>=32760){sourceClipping=true;break;}
 const voiceDuration=pcmBytes.length/2/24000,duration=voiceDuration+1.0;
 if(duration<25||duration>35)throw Error('v2_duration_failed');
 command('ffmpeg',['-y','-f','s16le','-ar','24000','-ac','1','-i',base+'.pcm','-af','highpass=f=80,deesser=i=0.15:m=0.3:f=0.5,acompressor=threshold=0.25:ratio=2:attack=10:release=100,loudnorm=I=-16:TP=-1.5:LRA=7','-c:a','pcm_s16le',base+'-voz.wav']);
 let alignment;if(align)alignment=await align(base+'-voz.wav',plan.speech);else{{const out=command('python3',[fileURLToPath(new URL('./align.py',import.meta.url)),base+'-voz.wav',base+'-roteiro.txt',base+'-alignment.json']);for(const line of out.split('\n'))if(/^ALIGN_ATTEMPT [a-z_]+ (ok|invalid|none|erro)\b/.test(line))console.log(line.slice(0,200));}alignment=JSON.parse(await readFile(base+'-alignment.json','utf8'));}
 const words=alignedWords(alignment,plan.speech,voiceDuration);
 await writeFile(base+'-legendas.ass',captions(words));
 const ctaStart=duration-3.5,firstCta=words.slice(-CTA.split(/\s+/).length)[0]?.start;
 if(!(firstCta>=duration-4&&firstCta<=duration-3))throw Error('cta_alignment_failed');
 let trackPath=fileURLToPath(new URL('../../'+track.arquivo,import.meta.url));
 if(library.buffers.has(track.arquivo)){trackPath=base+'-selected.ogg';await writeFile(trackPath,library.buffers.get(track.arquivo));}
 command('ffmpeg',['-y','-i',base+'-voz.wav','-i',trackPath,'-filter_complex',mixGraph(duration),'-map','[mix]','-t',String(duration),base+'-mix.wav','-map','[reference]','-t',String(duration),base+'-musica-reference.wav','-map','[stem]','-t',String(duration),base+'-musica-ducked.wav']);
 // Brand template + smooth push, with the baked-in logo masked for t < 2s.
 if(/[\[\]';:,\\]/.test(base))throw Error('unsafe_media_path');
 const font=fileURLToPath(new URL('../../assets/fonts/Inter-ExtraBold.ttf',import.meta.url));
 const wrap=(text,limit=19)=>text.split('\n').map(part=>part.split(/\s+/).reduce((rows,w)=>{const i=rows.length-1;if((rows[i]+' '+w).trim().length>limit)rows.push(w);else rows[i]=(rows[i]+' '+w).trim();return rows;},['']).join('\n')).join('\n\n');
 await writeFile(base+'-gancho-completo.txt',wrap(plan.sentences[0]));
 const firstSentenceEnd=words[plan.sentences[0].split(/\s+/).length-1].end;
 const scenes=sceneTimeline(plan,words,duration);
 await writeFile(base+'-scenes.json',JSON.stringify(scenes,null,2));
 const draws=[],sceneTexts=[];
 const textLines=async(path,text,size,color,y,start,end)=>{const lines=JSON.parse(command('python3',[fileURLToPath(new URL('./wrap-text.py',import.meta.url)),font,String(size),String(size===96?888:812),text]));const filters=[];for(let j=0;j<lines.length;j++){const linePath=j===0?path:path.replace('.txt','-linha-'+j+'.txt');await writeFile(linePath,lines[j]);filters.push(`drawtext=fontfile=${font}:textfile=${linePath}:fontsize=${size}:fontcolor=${color}:x=${size===96?96:115}:y=${y+j*(size+16)}:enable='between(t,${start},${end})'`);}return filters;};
 for(const scene of scenes.slice(1)){
  const i=scene.index,path=base+'-cena-'+i+'.txt',title=base+'-titulo-'+i+'.txt';
  await writeFile(path,wrap(scene.text,24));await writeFile(title,wrap(scene.title,24));sceneTexts.push(path);
  const start=scene.start,end=scene.end-0.000001,light=i%2===1;
  draws.push(`drawbox=x=76:y=580:w=928:h=770:color=${light?'0xe1ecff':'0x163d71'}:t=fill:enable='between(t,${start},${end})'`);
  draws.push(...await textLines(path,scene.text,62,light?'0x0c1c2b':'white',680,start,end));
  draws.push(`drawtext=fontfile=${font}:textfile=${title}:fontsize=72:fontcolor=white:x=96:y=260:line_spacing=8:enable='between(t,${start},${end})'`);
 }
 // Highlight changes within complete sentence scenes, never fragments.
 const sceneCount=Math.round(duration/2.5),sceneSpan=duration/sceneCount;
 for(let i=0;i<sceneCount;i++)draws.push(`drawbox=x=76:y=1370:w=928:h=16:color=${i%2?'0x00b8ff':'0xffe500'}:t=fill:enable='between(t,${i*sceneSpan},${Math.min(duration,(i+1)*sceneSpan)})'`);
 const hookDraws=await textLines(base+'-gancho.txt',plan.sentences[0],96,'white',220,0,firstSentenceEnd);
 const frames=Math.round(duration*30);
 const vf=["scale=1080:1920",`zoompan=z='1+0.04*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`,
 "drawbox=x=40:y=40:w=980:h=150:color=0x0b0f16:t=fill:enable='lt(t,2)'",
 "drawbox=x=0:y=600:w=1080:h=1100:color=0x0b0f16:t=fill",
 ...draws,"drawbox=x=60:y=1410:w=920:h=210:color=0x0b0f16:t=fill",
 ...hookDraws,
 `ass=${base}-legendas.ass:fontsdir=${dirname(font)}`];
 const bar=`color=c=0x202a38:s=888x10:r=30:d=${duration}[track];color=c=0x00b8ff:s=888x10:r=30:d=${duration}[fill];[track][fill]overlay=x='-888+888*t/${duration}':y=0:shortest=1[bar];[base][bar]overlay=x=96:y=1724:shortest=0:eof_action=repeat[v]`;
 const graph='[0:v]'+vf.join(',\n')+'[base];'+bar;
 await writeFile(base+'-filter.txt',graph);
 command('ffmpeg',['-y','-loop','1','-framerate','30','-i',fileURLToPath(new URL('../../assets/brand/export/short.png',import.meta.url)),'-i',base+'-mix.wav','-filter_complex_script',base+'-filter.txt','-map','[v]','-map','1:a','-t',String(duration),'-c:v','libx264','-threads','2','-preset','fast','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',base+'.mp4']);
 const visual=await visualMetrics(base,plan,words);contactSheet(base,visual);
 const voice=audioMetrics(base+'-voz.wav'),mix=audioMetrics(base+'.mp4');
 const windows=words.map(w=>({start:w.start,end:w.end}));const musicDb=rmsDb(pcm(base+'-musica-ducked.wav'),windows),referenceDb=rmsDb(pcm(base+'-musica-reference.wav'),windows),voiceDb=rmsDb(pcm(base+'-voz.wav'),windows);
 let internalSilence=0;for(let i=0;i<voice.starts.length;i++)if(voice.starts[i]>.1&&voice.starts[i]<words.at(-1).end-.1)internalSilence=Math.max(internalSilence,(voice.ends[i]??voiceDuration)-voice.starts[i]);
 const metrics={musicBedLufs:audioMetrics(base+'-musica-reference.wav').lufs,ppm:words.length/voiceDuration*60,internalSilence,clipping:sourceClipping||voice.peak>=0,voiceLufs:voice.lufs,duration,musicDetected:Number.isFinite(musicDb)&&musicDb>-70,duckingDb:referenceDb-musicDb,voiceMusicDb:voiceDb-musicDb,mixLufs:mix.lufs,truePeak:mix.peak,...visual,ctaSeconds:duration-firstCta,cta:CTA,voiceFixed:generated.voice===config.voz_fixa};
 const qc={...quality(metrics),metrics,voice:config.voz_fixa,track,model:config.modelo,containsSyntheticMedia:true,mode:preview?'preview':'production'};
 await writeFile(base+'-qc.json',JSON.stringify(qc,null,2));await copyFile(trackPath,base+'-musica.'+track.arquivo.split('.').at(-1));await writeFile(base+'-licenca.json',JSON.stringify(track,null,2));
 if(!qc.ok)throw Error('audio_qc_failed:'+qc.reasons.join('+'));
 return {file:base+'.mp4',duration,voice:'gemini:'+config.voz_fixa,audio:{ok:true,...metrics},qc,track,beats:{cta:ctaStart}};
}
