import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import * as mod from '../scripts/shorts-v2/preparation.mjs';import {readTextNormalized} from './helpers/text.mjs';import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../scripts/shorts-v2/preparation.mjs',import.meta.url),workflow=readTextNormalized(new URL('../.github/workflows/shorts-v2-amostras.yml',import.meta.url));
const config={modelo:'gemini-3.8-flash-tts',voz_fixa:'Achird',comparacao_aprovada:true,nivel_gratuito_confirmado:true,publicacao_aprovada:false};
async function gates(m){assert.throws(()=>m.assertPreparation('previa','false','true'));assert.throws(()=>m.assertPreparation('amostras','true','false'));assert.throws(()=>m.assertPreparation('publicar','true','true'));m.assertPreparation('amostras','true','true');}
test('Preparation: only explicit dry run and free tier; no publication mode',()=>gates(mod));
test('Preparation mutant: free-tier confirmation removed',()=>killedMutation(source,[["||freeTier!=='true'",'']],gates));
async function isolation(m){assert.equal(m.validatePreparationWorkflow(workflow),true);assert.throws(()=>m.validatePreparationWorkflow(workflow+'\n      YOUTUBE_REFRESH_TOKEN: forbidden'));assert.throws(()=>m.validatePreparationWorkflow(workflow.replace('workflow_dispatch:','push:')));}
test('Preparation: separate manual workflow, two jobs, no publisher credentials',()=>isolation(mod));
test('Preparation mutant: publisher credentials accepted',()=>killedMutation(source,[["if(/CLOUDFLARE|KV_NAMESPACE|YOUTUBE_|short-crosspost|youtube-daily-short\\.mjs|contents: write|actions: write/.test(text))","if(false)"]],isolation));
async function preview(m){const out=await mkdtemp(join(tmpdir(),'zev-preview-'));try{const original=JSON.stringify(config);let calls=0;const render=async(plan,base,options)=>{calls++;assert.equal(plan.v2,true);assert.equal(options.preview,true);assert.equal(options.config.publicacao_aprovada,false);assert.equal(await options.stateKv.get('anything'),null);await assert.rejects(()=>options.stateKv.put('x','y'),/forbidden/);return {file:base+'.mp4',voice:options.config.voz_fixa};};const r=await m.preparePreview({day:'2026-11-12',slot:'dica',out,config,key:'synthetic'},{render});assert.equal(calls,1);assert.equal(r.voice,'Achird');assert.equal(JSON.stringify(config),original);for(const flag of ['comparacao_aprovada','nivel_gratuito_confirmado'])await assert.rejects(()=>m.preparePreview({day:'2026-11-12',slot:'dica',out,config:{...config,[flag]:false},key:'synthetic'},{render}));assert.equal(calls,1);}finally{await rm(out,{recursive:true,force:true});}}
test('Preparation: preview renders with chosen voice, no approval mutation or runtime writes',()=>preview(mod));
test('Preparation mutant: preview flag removed',()=>killedMutation(source,[["{preview:true,config,geminiKey:key,stateKv,synthesize:sampleTts}","{preview:false,config,geminiKey:key,stateKv,synthesize:sampleTts}"]],preview));

// Laboratório de Criativos: o slot com especificação v3 ativa vai para o gerador v3 (que mede e decide sozinho), sempre
// em modo prévia, com a voz escolhida e sem escrita de estado.
test('Preparation: slot com v3 ativo usa renderV3 em prévia, com a voz escolhida', async () => {
  const out = await mkdtemp(join(tmpdir(), 'zev-preview-v3-'));
  try {
    let v2 = 0, args = null;
    const r = await mod.preparePreview({ day: '2026-11-12', slot: 'oferta', out, config, key: 'synthetic' }, { render: async () => { v2++; }, renderNovo: async (spec, base, o) => { args = { spec, o }; return { file: base + '.mp4' }; } });
    assert.equal(v2, 0); assert.equal(args.spec, 'data/shorts-v3/lcx.json'); assert.equal(args.o.preview, true); assert.equal(args.o.config.voz_fixa, 'Achird'); assert.ok(r.file.endsWith('short-preview.mp4'));
  } finally { await rm(out, { recursive: true, force: true }); }
});
test('v3: legenda julgada pelo efeito visível — grupo de 3 palavras na tela >= 0,30 s; instantâneas só dentro disso',async()=>{const {gruposCurtosV3}=await import('../scripts/shorts-v3/render.mjs');
 const w=(a)=>a.map(([s,e])=>({start:s,end:e}));
 const ok=w([[0,.2],[.2,.2],[.4,.6],[.9,1.1],[1.1,1.1],[1.1,1.3]]);// 2 frases de 3; instantâneas dentro de grupos de 0,9 s e 0,4 s
 assert.deepEqual(gruposCurtosV3(ok,[3,3],1.5),[]);
 const curto=w([[0,.2],[.2,.3],[.3,.4],[.5,.5],[.5,.5],[.5,.6],[.7,.9]]);// 2º grupo (3..5) dura só 0,2 s até o próximo
 assert.deepEqual(gruposCurtosV3(curto,[3,3,1],1),['3:0.20']);
 assert.deepEqual(gruposCurtosV3(w([[0,.1],[.1,.1]]),[2],0.2),['0:0.20']);
});
