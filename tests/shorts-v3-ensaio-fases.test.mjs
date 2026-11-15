// #1055: fases do código do PR no ensaio por PR — rodam sem chave; voz e júri vêm de jobs do gh-pages como dados.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {pedido,vozPronta,juriFora,render} from '../scripts/shorts-v3/ensaio-fases.mjs';
import {permitidosDe} from '../scripts/criativos/avaliador.mjs';
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
  // entrada inválida (sku fora do catálogo, sem MP4) -> as objetivas do candidato reprovam ANTES do júri
  await assert.rejects(render(join(d,'out'),voz,'oferta',{renderImpl,note:()=>{}}),/ensaio_objetivas_reprovadas/);
  assert.equal(opts.geminiKey,'juri-em-job-separado','nenhuma chave real chega ao código do PR');
  const pj=JSON.parse(readFileSync(join(d,'out','juri','juri-pedido.json'),'utf8'));
  assert.deepEqual(pj.quadros,['juri-0.png','juri-1.png']);assert.deepEqual(pj.audio,['voice_speed']);assert.deepEqual(pj.medicao,{m:1});
  assert.equal(readFileSync(join(d,'out','juri','juri-1.png'),'utf8'),'b');
 }finally{rmSync(d,{recursive:true,force:true});}
 const src=readTextNormalized('scripts/shorts-v3/ensaio-fases.mjs');
 assert.doesNotMatch(src,/process\.env\.GEMINI|fetch\(|generativelanguage/,'a fase do PR não lê chave nem chama o Gemini');
 assert.match(src,/assertPreparation\('previa',process\.env\.DRY_RUN,process\.env\.FREE_TIER_CONFIRMED\)/);
});

// GPT-6 (15/11): o júri do ensaio usa o avaliador do gh-pages; as objetivas NOVAS do candidato rodam no job do render
// (sem segredo), ficam vinculadas ao SHA-256 do MP4 e dos quadros do júri, e reprovação encerra antes do júri.
test('ensaio por PR: objetivas do candidato vinculadas ao SHA-256 do MP4/quadros; célula faltando ou duplicata param antes do júri',async()=>{
 const NUM={preco_venda:180,custo_produto_frete:132,taxa_cartao:9,taxa_cartao_pct:5,margem_antes_fixas:39,margem_pct:'21,7%',preco_minimo:176,desconto_maximo:'2,2%',meta_margem_pct:20};
 const C=[['celula-preco.png','R$ 180'],['celula-contribuicao.png','R$ 39'],['celula-margem.png','21,7%'],['celula-desconto.png','2,2%']];
 const leg=C.map(([c,valor])=>({captura:'/runner/assets/'+c,valor,altura_px:80,legivel:true}));
 const TELAS=['ZEVANORY LOJA LUCRO CAIXA Sua loja vende','Recebeu R$ 180 Produto frete R$ 132 Taxa do cartão (5%) R$9 Margem antes das despesas fixas R$ 39','Margem de contribuição 21,7%','Preço mínimo p/ meta de 20% R$ 176 Desconto máximo 2,2%','Lucro & Caixa R$ 147 pagamento único arrependimento em 7 dias'];
 const medicao=pl=>({quadros:TELAS.map(texto=>({texto})),medidas:{alturaTextoMinPx:24,foraAreaSegura:0,quadrosVazios:0,provaReal:true,textoNaoReconhecido:0,provasLegiveis:pl,provaIlegivel:0,origem:'medicao_independente_ocr'}});
 const criativo={sku:'ZEV-LCX-011',falas:['Sua loja vende, mas o dinheiro desaparece?','Kit Lucro e Caixa no link do perfil.'],oferta:{nome:'Lucro & Caixa',preco:147},celulasExigidas:C.map(([captura,valor])=>({captura,valor}))};
 const oficial={fonte:'https://vendas.zevanory.api.br/lucro-e-caixa',preco:147,versao:'sha256:t',lido_em:'2026-11-15T12:00:00Z'};
 const cfg=JSON.parse(readFileSync('data/shorts-padrao-v2.json','utf8')),texto=JSON.parse(readFileSync('data/shorts-v3/lcx.json','utf8')).falas.map(f=>f.texto).join(' ');
 const rodar=async(pl,audio=[])=>{const d=mkdtempSync(join(tmpdir(),'ef-obj-')),voz=join(d,'voz');mkdirSync(voz);
  writeFileSync(join(voz,'voz.pcm'),Buffer.alloc(96));writeFileSync(join(voz,'meta.json'),JSON.stringify({voice:cfg.voz_fixa,model:cfg.modelo,texto_sha256:sha(texto)}));
  const renderImpl=async(spec,base,o)=>{writeFileSync(base+'.mp4','mp4-'+pl.length);await o.avaliarImpl({criativo,padrao:{p:1},quadrosPng:[Buffer.from('q0'),Buffer.from('q1')],medicao:medicao(pl),permitidos:permitidosDe(NUM,147),oficial,key:o.geminiKey});return {file:base+'.mp4',qc:{audio:{reasons:audio}}};};
  let erro=null;try{await render(join(d,'out'),voz,'oferta',{renderImpl,note:()=>{}});}catch(e){erro=e;}
  const o=JSON.parse(readFileSync(join(d,'out','juri','objetivas-candidato.json'),'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(d,'out','objetivas-candidato.json'),'utf8')),o,'cópia no artefato do ensaio');
  const mp4=readFileSync(join(d,'out','short-preview.mp4'));rmSync(d,{recursive:true,force:true});return {o,erro,mp4};};
 const ok=await rodar(leg);
 assert.equal(ok.erro,null);assert.equal(ok.o.aprovado_objetivo,true,JSON.stringify(ok.o.motivos_objetivos));
 assert.equal(ok.o.mp4.sha256,sha(ok.mp4),'vinculado ao SHA-256 do MP4 renderizado');
 assert.deepEqual(ok.o.quadros_juri,[{arquivo:'juri-0.png',sha256:sha('q0')},{arquivo:'juri-1.png',sha256:sha('q1')}],'e aos quadros que o júri recebe');
 for(const [nome,pl] of [['célula retirada (3 de 4)',leg.filter((_,i)=>i!==2)],['duplicata no lugar de uma (contagem 4)',leg.map((p,i)=>i===2?{...leg[1]}:p)]]){
  const r=await rodar(pl);assert.match(String(r.erro?.message),/ensaio_objetivas_reprovadas/,nome);
  assert.equal(r.o.aprovado_objetivo,false,nome);assert.ok(r.o.motivos_objetivos.includes('celulas_exigidas_divergentes'),nome);}
 const a=await rodar(leg,['voice_speed']);assert.match(String(a.erro?.message),/ensaio_objetivas_reprovadas/);assert.equal(a.o.aprovado_objetivo,false);
});
