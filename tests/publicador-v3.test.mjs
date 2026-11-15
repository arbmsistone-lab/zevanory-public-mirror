// Shorts v3.8 no publicador diário (preparação; a ativação é decisão separada do proprietário): o slot OFERTA usa o
// render v3 quando o roteiro ativo é do mesmo produto do plano; o v3 só passa no gate do laço com o criativo APROVADO
// (objetivas + júri + áudio) e a decisão assinada; publicar continua exigindo publicacao_aprovada no padrão de voz.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {roteiroV3Para,planoV3,renderShort} from '../scripts/channels/youtube-daily-short.mjs';
const LCX='ZEV-LCX-011',plano=(slot='oferta',sku=LCX)=>({slot,entry:{product:{sku}},link:'https://vendas.zevanory.api.br/hotmart/lucro-e-caixa?utm_source=youtube',marker:'zevanory-short-key:abc',title:'t',description:'d',privacyStatus:'public'});
test('escolha do roteiro: v3 só no slot oferta e só para o produto do roteiro ativo',()=>{
 const r=roteiroV3Para(plano());assert.equal(r.path,'data/shorts-v3/lcx.json');assert.equal(r.spec.sku,LCX);
 assert.equal(roteiroV3Para(plano('dica')),null);assert.equal(roteiroV3Para(plano('calc')),null);
 assert.equal(roteiroV3Para(plano('oferta','ZEV-IAP-001')),null,'outro produto segue no v2');
 assert.equal(roteiroV3Para(plano(),{schema:1}),null,'sem roteiro ativo segue no v2');
});
test('plano v3: fala do roteiro e descrição com o link clicável no perfil (a URL fica como texto) e o marcador',()=>{
 const r=roteiroV3Para(plano()),p=planoV3(plano(),r.spec);
 assert.equal(p.v3,true);assert.equal(p.speech,r.spec.falas.map(f=>f.texto).join(' '));
 assert.match(p.description,/Link clicável no perfil do canal/);assert.ok(p.description.includes(plano().link));assert.ok(p.description.endsWith('zevanory-short-key:abc'));
 assert.doesNotMatch(p.description,/link (na|da) descrição/i);
});
test('render v3 no laço: só APROVADO (júri + objetivas + áudio + decisão) vira qc 100/ok; prévia e produção repassadas',async()=>{
 const r=roteiroV3Para(plano()),chamadas=[];
 const fake=(decisao,audioOk=true,assinada=decisao)=>async(path,base,o)=>{chamadas.push({path,preview:o.preview,key:o.geminiKey,voz:o.config.voz_fixa});return {file:base+'.mp4',duration:32,qc:{audio:{ok:audioOk,reasons:audioOk?[]:['cta']},track:{arquivo:'m'}},avaliacao:{decisao,motivos:decisao==='APROVADO'?[]:['nota_abaixo:prova=9']},decisao:{decisao:assinada}};};
 const ok=await renderShort(plano(),join(tmpdir(),'publicador-v3-x'),{geminiKey:'k',preview:true},{v3:r,renderV3Impl:fake('APROVADO')});
 assert.deepEqual([ok.v3,ok.qc.ok,ok.qc.score,ok.voice,ok.track.arquivo],[true,true,100,'gemini:Achird','m']);
 assert.deepEqual(chamadas[0],{path:'data/shorts-v3/lcx.json',preview:true,key:'k',voz:'Achird'});
 await renderShort(plano(),join(tmpdir(),'publicador-v3-x'),{geminiKey:'k',preview:false},{v3:r,renderV3Impl:fake('APROVADO')});assert.equal(chamadas[1].preview,false,'produção: o render v3 exige publicacao_aprovada');
 for(const f of [fake('DESCARTADO'),fake('APROVADO',false),fake('APROVADO',true,'DESCARTADO')]){const x=await renderShort(plano(),join(tmpdir(),'publicador-v3-x'),{},{v3:r,renderV3Impl:f});assert.deepEqual([x.qc.ok,x.qc.score],[false,0]);}
});
test('laço do publicador: plano v3 vai ao render, ao upload e ao registro; reprovação do v3 tem motivo próprio; decisão assinada exigida',()=>{
 const src=readTextNormalized('scripts/channels/youtube-daily-short.mjs');
 assert.match(src,/const v3 = roteiroV3Para\(plan\); const planoFinal = v3 \? planoV3\(plan, v3\.spec\) : plan;/);
 assert.match(src,/renderShort\(planoFinal, base, \{geminiKey:process\.env\.GEMINI_API_KEY,stateKv:lockKv,preview:dry\}, \{v3\}\)/);
 assert.match(src,/v3_criativo_nao_aprovado/);assert.match(src,/publishShort\(planoFinal, await readFile\(rendered\.file\)/);
 assert.match(src,/exigirAprovacao\(aprovacao\?\.decisao, mp4/);
 const pad=JSON.parse(readTextNormalized('data/shorts-padrao-v2.json'));assert.equal(pad.publicacao_aprovada,false,'esta preparação não ativa publicação');
});
