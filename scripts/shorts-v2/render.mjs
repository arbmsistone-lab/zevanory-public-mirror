import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {STYLE,CTA,assertVoice,licensedTrack,alignedWords,captions,quality,musicHistory} from './core.mjs';
export function command(cmd,args,{buffer=false}={}){const p=spawnSync(cmd,args,{encoding:buffer?null:'utf8',maxBuffer:128*1024*1024});if(p.status!==0)throw Error('media_tool_failed:'+cmd);return buffer?p.stdout:String(p.stdout||'')+String(p.stderr||'');}
export async function tts(text,voice,key,{fetchImpl=fetch,freeTierConfirmed=false}={}){if(!key||!freeTierConfirmed)throw Error('free_tts_not_confirmed');const r=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:STYLE+'\n\n'+text}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}}}}),signal:AbortSignal.timeout(60000)}).catch(()=>{throw Error('free_tts_network_failed');});if(!r.ok)throw Error('free_tts_unavailable');const body=await r.json().catch(()=>{throw Error('tts_response_invalid');});const p=body.candidates?.[0]?.content?.parts?.find(x=>x.inlineData?.data);if(!p||!/audio\/(L16|pcm)/i.test(p.inlineData.mimeType||''))throw Error('tts_pcm_invalid');const rate=Number(/rate=(\d+)/.exec(p.inlineData.mimeType)?.[1]||24000);if(rate!==24000)throw Error('tts_rate_invalid');return {pcm:Buffer.from(p.inlineData.data,'base64'),voice};}
export function audioMetrics(file){const out=command('ffmpeg',['-hide_banner','-nostats','-i',file,'-vn','-af','ebur128=peak=true,silencedetect=n=-35dB:d=0.05','-f','null','-']);const lufs=Number([...out.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1]),peak=Number([...out.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].at(-1)?.[1]);const starts=[...out.matchAll(/silence_start: ([\d.]+)/g)].map(m=>+m[1]),ends=[...out.matchAll(/silence_end: ([\d.]+)/g)].map(m=>+m[1]);return {lufs,peak,starts,ends};}
function pcm(file){return command('ffmpeg',['-v','error','-i',file,'-f','f32le','-ac','1','-ar','24000','pipe:1'],{buffer:true});}
export function rmsDb(bytes,windows){let sum=0,n=0;for(const w of windows){for(let i=Math.max(0,Math.ceil(w.start*24000));i<Math.min(bytes.length/4,Math.floor(w.end*24000));i++){const v=bytes.readFloatLE(i*4);sum+=v*v;n++;}}return n&&sum>0?10*Math.log10(sum/n):-Infinity;}
export function mixGraph(duration){return `[0:a]asplit=2[voice][side];[1:a]loudnorm=I=-28:TP=-4:LRA=7,afade=t=in:d=0.5,afade=t=out:st=${duration-1.5}:d=1.5,asplit=2[reference][bed];[bed][side]sidechaincompress=threshold=0.005:ratio=12:attack=10:release=250:makeup=1,asplit=2[ducked][stem];[voice][ducked]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=7[mix]`;}
export async function renderV2(plan,base,{geminiKey,preview=false,stateKv,config:injectedConfig,align,synthesize=tts}={}){
 if(plan.v2!==true)throw Error('v2_plan_required');
 const config=injectedConfig||JSON.parse(await readFile(new URL('../../data/shorts-padrao-v2.json',import.meta.url),'utf8'));
 assertVoice(config,config.voz_fixa,{preview});
 if(!stateKv?.get||!stateKv?.put)throw Error('music_history_unavailable');
 const manifest=JSON.parse(await readFile(new URL('../../data/musica-licencas.json',import.meta.url),'utf8'));
 const last=await musicHistory(stateKv,plan.day,{files:manifest.faixas.map(r=>r.arquivo)});
 const track=await licensedTrack({theme:plan.theme,last,manifest});
 // Reserving the chosen bed before any render avoids immediate repetition after failure.
 if(!preview){const receipt=JSON.stringify({arquivo:track.arquivo,em:Date.now()});await stateKv.put('zpc:shorts:v2:musica:receipt:'+plan.day+':'+plan.slot,receipt);await stateKv.put('zpc:shorts:v2:musica:last',receipt);}
 await mkdir(dirname(base),{recursive:true});
 const generated=await synthesize(plan.speech,config.voz_fixa,geminiKey,{freeTierConfirmed:config.nivel_gratuito_confirmado});
 assertVoice(config,generated.voice,{preview});const pcmBytes=generated.pcm;
 await writeFile(base+'.pcm',pcmBytes);await writeFile(base+'-roteiro.txt',plan.speech);
 let sourceClipping=false;for(let i=0;i+1<pcmBytes.length;i+=2)if(Math.abs(pcmBytes.readInt16LE(i))>=32760){sourceClipping=true;break;}
 const voiceDuration=pcmBytes.length/2/24000,duration=voiceDuration+1.0;
 if(duration<25||duration>35)throw Error('v2_duration_failed');
 command('ffmpeg',['-y','-f','s16le','-ar','24000','-ac','1','-i',base+'.pcm','-af','highpass=f=80,deesser=i=0.15:m=0.3:f=0.5,acompressor=threshold=0.25:ratio=2:attack=10:release=100,loudnorm=I=-16:TP=-1.5:LRA=7','-c:a','pcm_s16le',base+'-voz.wav']);
 let alignment;if(align)alignment=await align(base+'-voz.wav',plan.speech);else{command('python3',[fileURLToPath(new URL('./align.py',import.meta.url)),base+'-voz.wav',base+'-roteiro.txt',base+'-alignment.json']);alignment=JSON.parse(await readFile(base+'-alignment.json','utf8'));}
 const words=alignedWords(alignment,plan.speech,voiceDuration);
 await writeFile(base+'-legendas.ass',captions(words));
 const ctaStart=duration-3.5,firstCta=words.slice(-CTA.split(/\s+/).length)[0]?.start;
 if(!(firstCta>=duration-4&&firstCta<=duration-3))throw Error('cta_alignment_failed');
 const trackPath=fileURLToPath(new URL('../../'+track.arquivo,import.meta.url));
 command('ffmpeg',['-y','-i',base+'-voz.wav','-i',trackPath,'-filter_complex',mixGraph(duration),'-map','[mix]','-t',String(duration),base+'-mix.wav','-map','[reference]','-t',String(duration),base+'-musica-reference.wav','-map','[stem]','-t',String(duration),base+'-musica-ducked.wav']);
 // New graphic from text/colors only: no logo or greeting at the opening.
 await writeFile(base+'-gancho.txt',plan.sentences[0].split(' ').reduce((a,w)=>{const i=a.length-1;if((a[i]+' '+w).trim().length>22)a.push(w);else a[i]=(a[i]+' '+w).trim();return a;},['']).join('\n'));await writeFile(base+'-cta.txt',CTA);
 const ass=base+'-legendas.ass',hook=base+'-gancho.txt',cta=base+'-cta.txt';
 if(/[\[\]';:,\\]/.test(base))throw Error('unsafe_media_path');
 const sceneCount=Math.round(duration/2.5),sceneSpan=duration/sceneCount;
 const scenes=Array.from({length:sceneCount},(_,i)=>`drawbox=x=${80+(i%2)*30}:y=720:w=800:h=200:color=${i%2?'0x005b83':'0x123952'}:t=fill:enable='between(t,${i*sceneSpan},${(i+1)*sceneSpan})'`).join(',');
 const vf=`${scenes},drawbox=x=60:y=160:w=860:h=430:color=0x102b43:t=fill,drawtext=textfile=${hook}:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=58:fontcolor=white:x=90:y=260:enable='lt(t,2)',drawbox=x=80:y=740:w=820:h=180:color=0x005b83:t=fill,drawtext=text='ZEVANORY':fontsize=44:fontcolor=white:x=100:y=1500:enable='gte(t,2)',ass=${ass},drawtext=textfile=${cta}:fontsize=42:fontcolor=white:x=85:y=1450:enable='gte(t,${ctaStart})'`;
 command('ffmpeg',['-y','-f','lavfi','-i',`color=c=0x071018:s=1080x1920:r=30:d=${duration}`,'-i',base+'-mix.wav','-vf',vf,'-t',String(duration),'-c:v','libx264','-preset','fast','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',base+'.mp4']);
 const voice=audioMetrics(base+'-voz.wav'),mix=audioMetrics(base+'.mp4');
 const windows=words.map(w=>({start:w.start,end:w.end}));const musicDb=rmsDb(pcm(base+'-musica-ducked.wav'),windows),referenceDb=rmsDb(pcm(base+'-musica-reference.wav'),windows),voiceDb=rmsDb(pcm(base+'-voz.wav'),windows);
 let internalSilence=0;for(let i=0;i<voice.starts.length;i++)if(voice.starts[i]>.1&&voice.starts[i]<words.at(-1).end-.1)internalSilence=Math.max(internalSilence,(voice.ends[i]??voiceDuration)-voice.starts[i]);
 const metrics={ppm:words.length/voiceDuration*60,internalSilence,clipping:sourceClipping||voice.peak>=0,voiceLufs:voice.lufs,duration,musicDetected:Number.isFinite(musicDb)&&musicDb>-70,duckingDb:referenceDb-musicDb,voiceMusicDb:voiceDb-musicDb,mixLufs:mix.lufs,truePeak:mix.peak,hookStart:words[0].start,hookQuestion:plan.sentences[0].endsWith('?'),opensWithLogo:false,captionX:100,captionRight:900,captionBottom:1250,captionFont:86,aligned:true,sceneMaxGap:sceneSpan,sceneMinGap:sceneSpan,ctaSeconds:duration-firstCta,cta:CTA,voiceFixed:generated.voice===config.voz_fixa};
 const qc={...quality(metrics),metrics,voice:config.voz_fixa,track,containsSyntheticMedia:true,mode:preview?'preview':'production'};
 await writeFile(base+'-qc.json',JSON.stringify(qc,null,2));await copyFile(trackPath,base+'-musica.flac');await writeFile(base+'-licenca.json',JSON.stringify(track,null,2));
 if(!qc.ok)throw Error('audio_qc_failed:'+qc.reasons.join('+'));
 return {file:base+'.mp4',duration,voice:'gemini:'+config.voz_fixa,audio:{ok:true,...metrics},qc,track,beats:{cta:ctaStart}};
}
