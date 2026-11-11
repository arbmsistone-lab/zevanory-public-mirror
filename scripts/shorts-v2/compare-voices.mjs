// Prepared only; no network call is made by tests or CI. Requires an authorized
// free-tier-only comparison run, never publishes and never changes the selection.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {tts,command,audioMetrics} from './render.mjs';
import {resolve} from 'node:path';
const config=JSON.parse(await readFile(new URL('../../data/shorts-padrao-v2.json',import.meta.url),'utf8'));
if(config.nivel_gratuito_confirmado!==true)throw Error('free_tier_owner_confirmation_pending');
const dest=resolve(process.argv[2]||'/tmp/zevanory-voice-comparison');await mkdir(dest,{recursive:true});
const phrase='Tá refazendo a mesma tarefa todo dia? Escolha um passo pequeno. Na ZEVANORY, a gente começa pelo que dá pra conferir.';
const report={phrase,candidates:[],selected:null,status:'owner_listening_required'};
for(const voice of config.candidatas){const generated=await tts(phrase,voice,process.env.GEMINI_API_KEY,{freeTierConfirmed:true});await writeFile(dest+'/'+voice+'.pcm',generated.pcm);command('ffmpeg',['-y','-f','s16le','-ar','24000','-ac','1','-i',dest+'/'+voice+'.pcm','-af','loudnorm=I=-16:TP=-1.5:LRA=7',dest+'/'+voice+'.wav']);report.candidates.push({voice,metrics:audioMetrics(dest+'/'+voice+'.wav'),file:voice+'.wav'});}
await writeFile(dest+'/comparacao.json',JSON.stringify(report,null,2));
