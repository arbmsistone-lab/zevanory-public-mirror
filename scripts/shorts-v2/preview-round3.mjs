// Offline evidence only: synthetic tone and explicit word timestamps; no provider or publication.
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {planSlot} from '../channels/youtube-daily-short.mjs';
import {planV2} from './core.mjs';
import {renderV2} from './render.mjs';
const config={modelo:'gemini-3.8-flash-tts',voz_fixa:'Achird',comparacao_aprovada:true,nivel_gratuito_confirmado:true,publicacao_aprovada:false};
const output=process.argv[2]||'/tmp/zev-shorts-round3';await mkdir(output,{recursive:true});const reports=[];
for(const [day,slot] of [['2026-11-12','dica'],['2026-11-13','calc'],['2026-11-14','oferta']]){
 const p=planV2(planSlot(day,slot,{hotmartOpen:true}),{hotmartOpen:true}),tokens=p.speech.split(/\s+/),duration=28,n=tokens.length-7;
 const words=tokens.map((word,i)=>({word,start:i<n?i*(duration-2.5)/n:duration-2.5+(i-n)*2.5/7,end:(i<n?(i+1)*(duration-2.5)/n:duration-2.5+(i-n+1)*2.5/7)-.025}));
 const pcm=Buffer.alloc(24000*duration*2);for(let i=0;i<pcm.length/2;i++){const t=i/24000,on=words.some(w=>t>=w.start&&t<=w.end);pcm.writeInt16LE(Math.round((on?.16*Math.sin(t*2*Math.PI*220):0)*32767),i*2);}
 const base=output+'/'+day+'-'+slot;const result=await renderV2(p,base,{preview:true,config,stateKv:{get:async()=>null,put:async()=>{throw Error('offline preview write');}},synthesize:async()=>({pcm,voice:'Achird',model:config.modelo}),align:async()=>({segments:[{words}]})});reports.push({day,slot,file:base+'.mp4',sentences:p.sentences,qc:result.qc});console.log(JSON.stringify({day,slot,ok:result.qc.ok,metrics:{contrast:result.qc.metrics.captionContrast,voiceMusicDb:result.qc.metrics.voiceMusicDb,duckingDb:result.qc.metrics.duckingDb}}));
}await writeFile(output+'/reports.json',JSON.stringify(reports,null,2));
