import {validateScenes} from './scenes.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=new URL('../../',import.meta.url);
function tool(cmd,args){const p=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:64*1024*1024});if(p.status!==0)throw Error('visual_tool_failed:'+cmd);return String(p.stdout||'')+String(p.stderr||'');}
const seconds=t=>t.split(':').reduce((a,b)=>a*60+Number(b),0);
export async function visualMetrics(base,plan,words){
 const graph=await readFile(base+'-filter.txt','utf8'),ass=await readFile(base+'-legendas.ass','utf8');
 const textGeometry=JSON.parse(tool('python3',[fileURLToPath(new URL('./inspect-text.py',import.meta.url)),base+'-filter.txt']));
 const rows=JSON.parse(tool('python3',[fileURLToPath(new URL('./inspect-captions.py',import.meta.url)),base+'-legendas.ass',fileURLToPath(new URL('assets/fonts/Inter-ExtraBold.ttf',root))]));
 const hook=/drawtext=[^;\n]*textfile=[^;\n]*-gancho.txt:fontsize=(\d+)[^;\n]*enable='between\(t,([\d.]+),([\d.]+)\)'/.exec(graph);
 const openingTexts=[];for(const line of graph.split('\n').filter(l=>l.includes('drawtext='))){const when=/enable='between\(t,([\d.]+),([\d.]+)\)'/.exec(line);if(!when||Number(when[1])<2){const path=/textfile=([^:]+)/.exec(line)?.[1];if(path)openingTexts.push(await readFile(path,'utf8'));}}
 const maskedLogo=graph.includes("drawbox=x=40:y=40:w=980:h=150:color=0x0b0f16:t=fill:enable='lt(t,2)'");
 const probe=JSON.parse(tool('ffprobe',['-v','error','-show_format','-show_streams','-of','json',base+'.mp4'])),duration=Number(probe.format.duration);
 const scenes=JSON.parse(await readFile(base+'-scenes.json','utf8'));
 const sceneSentenceAligned=validateScenes(scenes,plan,words,duration);
 for(const scene of scenes.slice(1)){const stem=base+'-cena-'+scene.index;const drawn=graph.split('\n').filter(l=>l.includes('textfile='+stem+'.txt:')||l.includes('textfile='+stem+'-linha-'));if(!drawn.length)throw Error('scene_sentence_boundary');const actual=[];for(const line of drawn){const path=/textfile=([^:]+)/.exec(line)?.[1];actual.push(await readFile(path,'utf8'));if(!line.includes(`enable='between(t,${scene.start},${scene.end-0.000001})'`))throw Error('scene_sentence_boundary');}if(actual.join(' ').replace(/\s+/g,' ').trim()!==scene.text)throw Error('scene_sentence_boundary');}

 const measurement=base+'-caption-measurements.json';await writeFile(measurement,JSON.stringify(rows));
 const contrast=JSON.parse(tool('python3',[fileURLToPath(new URL('./inspect-contrast.py',import.meta.url)),base+'.mp4',measurement]));
 const sceneLog=tool('ffmpeg',['-hide_banner','-nostats','-i',base+'.mp4','-vf',"crop=928:16:76:1370,select='gt(scene,0.12)',showinfo",'-an','-f','null','-']);
 const cuts=[...sceneLog.matchAll(/pts_time:([\d.]+)/g)].map(m=>+m[1]).filter(t=>t>.15&&t<duration-.15);
 const unique=[...new Set(cuts)],gaps=[0,...unique,duration].slice(1).map((t,i)=>t-[0,...unique][i]);
 const aligned=rows.length===words.length&&rows.every((r,i)=>r.word===words[i].word.replace(/[{}\\\r\n]/g,'')&&Math.abs(seconds(r.start)-words[i].start)<=.011&&Math.abs(seconds(r.end)-words[i].end)<=.011)&&ass.includes('Alignment,');
 const video=probe.streams.find(s=>s.codec_type==='video');
 const result={videoDuration:Number(video.duration),videoFrames:Number(video.nb_frames),textRight:textGeometry.right,sceneSentenceAligned,captionContrast:contrast.minimum,captionContrastSamples:contrast.samples,duration,hookStart:hook?+hook[2]:Infinity,hookFont:hook?+hook[1]:0,hookEnd:hook?+hook[3]:0,firstSentenceEnd:words[plan.sentences[0].split(/\s+/).length-1].end,hookQuestion:(await readFile(base+'-gancho-completo.txt','utf8')).trim().endsWith('?'),opensWithLogo:!maskedLogo||openingTexts.some(t=>/ZEVANORY/i.test(t)),captionX:Math.min(...rows.map(r=>r.left)),captionRight:Math.max(...rows.map(r=>r.right)),captionBottom:Math.max(...rows.map(r=>r.bottom)),captionFont:Math.min(...rows.map(r=>r.font)),aligned,sceneMinGap:Math.min(...gaps),sceneMaxGap:Math.max(...gaps),sceneCuts:unique,captionMeasurements:rows};
 await writeFile(base+'-visual.json',JSON.stringify(result,null,2));return result;
}
export function contactSheet(base,visual){
 const points=[0,...visual.sceneCuts].map(t=>Math.floor((t+.1)*30));
 tool('ffmpeg',['-y','-i',base+'.mp4','-vf',`select='${points.map(n=>`eq(n,${n})`).join('+')}',scale=270:480,tile=4x${Math.ceil(points.length/4)}`,'-frames:v','1',base+'-contato.png']);
}
