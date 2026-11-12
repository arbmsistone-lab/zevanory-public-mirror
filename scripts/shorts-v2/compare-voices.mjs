// Preparation only. This command never publishes or changes the chosen model.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tts,command,audioMetrics} from './render.mjs';
import {assertSamplesMode,sampleTts} from './voice-samples-mode.mjs';
import {resolve} from 'node:path';
export const phrase='Tá refazendo a mesma tarefa todo dia? Escolha um passo pequeno. Na ZEVANORY, a gente começa pelo que dá pra conferir.';
export function comparisons(config){
 if(config.candidatas?.length!==4||new Set(config.candidatas).size!==4||JSON.stringify(config.modelos_comparacao)!==JSON.stringify(['gemini-3.8-flash-tts','gemini-2.5-flash-preview-tts']))throw Error('comparison_matrix_invalid');
 return config.modelos_comparacao.flatMap(model=>config.candidatas.map(voice=>({model,voice,name:model+'-'+voice})));
}
export async function compareVoices(config,dest,{key,synthesize=tts,run=command,measure=audioMetrics}={}){
 if(config.nivel_gratuito_confirmado!==true)throw Error('free_tier_owner_confirmation_pending');
 if(!key)throw Error('comparison_credential_missing');
 await mkdir(dest,{recursive:true});
 const report={phrase,candidates:[],selected:null,status:'owner_listening_required'};
 for(const {voice,model,name} of comparisons(config)){
  const generated=await synthesize(phrase,voice,key,{model,freeTierConfirmed:true});
  if(generated.voice!==voice||generated.model!==model)throw Error('comparison_identity_mismatch');
  await writeFile(dest+'/'+name+'.pcm',generated.pcm);
  run('ffmpeg',['-y','-f','s16le','-ar','24000','-ac','1','-i',dest+'/'+name+'.pcm','-af','loudnorm=I=-16:TP=-1.5:LRA=7',dest+'/'+name+'.wav']);
  report.candidates.push({voice,model,metrics:measure(dest+'/'+name+'.wav'),file:name+'.wav'});
  await writeFile(dest+'/comparacao.json',JSON.stringify(report,null,2));
 }
 await writeFile(dest+'/index.html','<!doctype html><meta charset="utf-8"><title>Amostras de voz</title><h1>Escolha a voz ZEVANORY</h1><p>Mesma frase, quatro vozes e dois modelos. Nenhuma vencedora automática.</p>'+report.candidates.map(r=>'<section><h2>'+r.model+' — '+r.voice+'</h2><audio controls src="'+r.file+'"></audio><pre>'+JSON.stringify(r.metrics)+'</pre></section>').join(''));
 return report;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const samples=process.argv[2]==='--samples';
 try{
 if(samples)assertSamplesMode('amostras',process.env.DRY_RUN);
 const config=JSON.parse(await readFile(new URL('../../data/shorts-padrao-v2.json',import.meta.url),'utf8'));
 // Owner confirmed no billing on 12/11; comparison permission does not approve publication.
 await compareVoices(samples?{...config,nivel_gratuito_confirmado:true}:config,resolve(process.argv[samples?3:2]||'/tmp/zevanory-voice-comparison'),{key:process.env.GEMINI_API_KEY,...(samples?{synthesize:sampleTts}:{})});
 }catch(e){console.error('::error title=GEMINI::'+String(e.geminiCode||e.message).replace(/[^a-zA-Z0-9_:.-]/g,'_'));process.exitCode=1;}
}
