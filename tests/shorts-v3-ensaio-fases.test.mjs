// #1055: fases do código do PR no ensaio por PR — rodam sem chave; voz e júri vêm de jobs do gh-pages como dados.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {pedido,vozPronta,juriFora,render} from '../scripts/shorts-v3/ensaio-fases.mjs';
const sha=t=>createHash('sha256').update(t).digest('hex');
test('ensaio por PR: pedido de voz = falas do roteiro ativo + voz/modelo fixos; voz pronta só serve para o MESMO texto',async()=>{
 const d=mkdtempSync(join(tmpdir(),'ef-'));try{
  const p=await pedido(d,'oferta');const spec=JSON.parse(readFileSync('data/shorts-v3/lcx.json','utf8')),cfg=JSON.parse(readFileSync('data/shorts-padrao-v2.json','utf8'));
  assert.equal(p.texto,spec.falas.map(f=>f.texto).join(' '));assert.equal(p.voz,cfg.voz_fixa);assert.equal(p.modelo,cfg.modelo);
  assert.deepEqual(JSON.parse(readFileSync(join(d,'pedido-voz.json'),'utf8')),p);
  await assert.rejects(pedido(d,'dica'),/ensaio_slot_sem_v3/);
  const meta={voice:cfg.voz_fixa,model:cfg.modelo,texto_sha256:sha(p.texto)},s=vozPronta({pcm:Buffer.alloc(48),meta});
  assert.equal((await s(p.texto,cfg.voz_fixa,'qualquer',{model:cfg.modelo})).pcm.length,48);
  await assert.rejects(s(p.texto+' extra',cfg.voz_fixa,'',{model:cfg.modelo}),/ensaio_texto_diverge_da_voz/);
  await assert.rejects(s(p.texto,'Kore','',{model:cfg.modelo}),/ensaio_voz_ou_modelo_diverge/);
  assert.throws(()=>vozPronta({pcm:Buffer.alloc(3),meta}),/ensaio_voz_pronta_invalida/);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('ensaio por PR: júri fora grava quadros e pedido como dados; o render anexa as falhas de áudio medidas',async()=>{
 const d=mkdtempSync(join(tmpdir(),'ef-'));try{
  const voz=join(d,'voz');mkdirSync(voz);const cfg=JSON.parse(readFileSync('data/shorts-padrao-v2.json','utf8'));
  const texto=JSON.parse(readFileSync('data/shorts-v3/lcx.json','utf8')).falas.map(f=>f.texto).join(' ');
  writeFileSync(join(voz,'voz.pcm'),Buffer.alloc(96));writeFileSync(join(voz,'meta.json'),JSON.stringify({voice:cfg.voz_fixa,model:cfg.modelo,texto_sha256:sha(texto)}));
  let opts=null;const renderImpl=async(spec,base,o)=>{opts=o;await o.synthesize(texto,cfg.voz_fixa,o.geminiKey,{model:cfg.modelo});
   const av=await o.avaliarImpl({criativo:{sku:'X'},padrao:{p:1},quadrosPng:[Buffer.from('a'),Buffer.from('b')],medicao:{m:1},permitidos:{r:[]},oficial:null,key:o.geminiKey});
   assert.equal(av.decisao,'PENDENTE_JURI');return {qc:{audio:{reasons:['voice_speed']}}};};
  await render(join(d,'out'),voz,'oferta',{renderImpl,note:()=>{}});
  assert.equal(opts.geminiKey,'juri-em-job-separado','nenhuma chave real chega ao código do PR');
  const pj=JSON.parse(readFileSync(join(d,'out','juri','juri-pedido.json'),'utf8'));
  assert.deepEqual(pj.quadros,['juri-0.png','juri-1.png']);assert.deepEqual(pj.audio,['voice_speed']);assert.deepEqual(pj.medicao,{m:1});
  assert.equal(readFileSync(join(d,'out','juri','juri-1.png'),'utf8'),'b');
 }finally{rmSync(d,{recursive:true,force:true});}
 const src=readTextNormalized('scripts/shorts-v3/ensaio-fases.mjs');
 assert.doesNotMatch(src,/process\.env\.GEMINI|fetch\(|generativelanguage/,'a fase do PR não lê chave nem chama o Gemini');
 assert.match(src,/assertPreparation\('previa',process\.env\.DRY_RUN,process\.env\.FREE_TIER_CONFIRMED\)/);
});
