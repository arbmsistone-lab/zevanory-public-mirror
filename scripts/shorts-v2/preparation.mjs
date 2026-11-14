// Offline preparation path: no publishing client, runtime KV or approval writes.
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planSlot} from '../channels/youtube-daily-short.mjs';
import {planV2,assertVoice} from './core.mjs';
import {renderV2} from './render.mjs';
import {sampleTts} from './voice-samples-mode.mjs';
import {renderV3} from '../shorts-v3/render.mjs';
import ATIVO_V3 from '../../data/shorts-v3/ativo.json' with {type:'json'};
export function assertPreparation(mode,dryRun,freeTier){
 if(!['amostras','previa'].includes(mode)||dryRun!=='true'||freeTier!=='true')throw Error('preparation_requires_dry_run_and_free_tier_confirmation');
}
export async function preparePreview({day,slot,out,config,key},{render=renderV2,renderNovo=renderV3}={}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day||!['dica','oferta','calc'].includes(slot))throw Error('preview_target_invalid');
 assertVoice(config,config?.voz_fixa,{preview:true});
 if(!key)throw Error('preview_credential_missing');
 const base=resolve(out,'short-preview');await mkdir(resolve(out),{recursive:true});
 const stateKv={get:async()=>null,put:async()=>{throw Error('preview_runtime_write_forbidden');}};
 // Visual v3 (Laboratório de Criativos): o slot com especificação ativa usa o gerador v3, que mede e decide sozinho.
 if(typeof ATIVO_V3?.[slot]==='string')return renderNovo(ATIVO_V3[slot],base,{preview:true,config,geminiKey:key,synthesize:sampleTts});
 const plan=planV2(planSlot(day,slot,{hotmartOpen:true}),{hotmartOpen:true});
 return render(plan,base,{preview:true,config,geminiKey:key,stateKv,synthesize:sampleTts});
}
export function validatePreparationWorkflow(text){
 if(!/on:\s*\n  workflow_dispatch:/.test(text)||/^  (schedule|push|pull_request|workflow_run):/m.test(text))throw Error('preparation_trigger_invalid');
 if(!text.includes('  amostras:')||!text.includes('  previa:')||!text.includes('FREE_TIER_CONFIRMED: ${{ inputs.nivel_gratuito_confirmado }}')||!text.includes("DRY_RUN: 'true'")||!text.includes("inputs.modo == 'amostras'")||!text.includes("inputs.modo == 'previa'"))throw Error('preparation_mode_invalid');
 if(/CLOUDFLARE|KV_NAMESPACE|YOUTUBE_|short-crosspost|youtube-daily-short\.mjs|contents: write|actions: write/.test(text))throw Error('preparation_publish_isolation');
 // Todo job (amostras, previa e, no v3.4, autorizar-ensaio/ensaio) só roda a partir do gh-pages.
 const jobs=(text.split(/\njobs:\n/)[1]||'').match(/^  [a-z][\w-]*:\n/gm)||[],refs=[...text.matchAll(/if:.*github\.ref == 'refs\/heads\/gh-pages'/g)];if(jobs.length<2||refs.length!==jobs.length)throw Error('preparation_ref_invalid');
 return true;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 try{
  assertPreparation('previa',process.env.DRY_RUN,process.env.FREE_TIER_CONFIRMED);
  const config=JSON.parse(await readFile(new URL('../../data/shorts-padrao-v2.json',import.meta.url),'utf8'));
  await preparePreview({day:process.env.PREVIEW_DAY,slot:process.env.PREVIEW_SLOT,out:process.argv[2],config,key:process.env.GEMINI_API_KEY});
 }catch(e){console.error('::error title=SHORTS_PREPARATION::'+String(e.geminiCode||e.message).replace(/[^a-zA-Z0-9_:.-]/g,'_'));process.exitCode=1;}
}
