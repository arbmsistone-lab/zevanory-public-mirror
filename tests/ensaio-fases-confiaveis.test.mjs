// #1055 (contra-auditoria GPT-6): as fases que recebem GEMINI_API_KEY rodam só código do gh-pages e tratam o que vem
// do código do PR como DADO validado (pedido de voz em JSON, quadros PNG 540x960, pedido do júri em JSON).
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {validarPedidoVoz,gerarVoz,TEXTO_MAX} from '../scripts/ci/ensaio-voz.mjs';
import {lerQuadro,validarPedidoJuri,julgar,QUADROS_MAX} from '../scripts/ci/ensaio-juri.mjs';
const CFG={voz_fixa:'Achird',modelo:'gemini-3.8-flash-tts'},TXT='Sua loja vende, mas o dinheiro desaparece? Lucro e Caixa: cento e quarenta e sete reais.';
const png=(w=540,h=960,extra=0)=>{const b=Buffer.alloc(33+extra);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12,'latin1');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
const tmp=()=>mkdtempSync(join(tmpdir(),'ens-'));
test('voz: pedido validado (texto, voz e modelo fixos do gh-pages); só então a chave vai ao TTS',async()=>{
 assert.deepEqual(validarPedidoVoz({texto:TXT,voz:'Achird',modelo:'gemini-3.8-flash-tts'},CFG),{texto:TXT,voz:'Achird',modelo:'gemini-3.8-flash-tts'});
 for(const [p,e] of [[null,'ensaio_pedido_invalido'],[[],'ensaio_pedido_invalido'],[{texto:'',voz:'Achird',modelo:CFG.modelo},'ensaio_texto_invalido'],
  [{texto:'x'.repeat(TEXTO_MAX+1),voz:'Achird',modelo:CFG.modelo},'ensaio_texto_invalido'],[{texto:'oi <script>',voz:'Achird',modelo:CFG.modelo},'ensaio_texto_invalido'],
  [{texto:'oi\u0000',voz:'Achird',modelo:CFG.modelo},'ensaio_texto_invalido'],[{texto:TXT,voz:'Kore',modelo:CFG.modelo},'ensaio_voz_diferente_da_fixa'],
  [{texto:TXT,voz:'Achird',modelo:'gemini-pro-pago'},'ensaio_modelo_diferente_do_fixo']])assert.throws(()=>validarPedidoVoz(p,CFG),new RegExp(e));
 const d=tmp();try{const ped=join(d,'p.json');writeFileSync(ped,JSON.stringify({texto:TXT,voz:'Achird',modelo:CFG.modelo}));
  const chamadas=[];const ttsImpl=async(t,v,k,o)=>{chamadas.push({t,v,k,o});return {pcm:Buffer.alloc(4800),voice:v,model:o.model};};
  const m=await gerarVoz({pedidoPath:ped,outDir:join(d,'voz'),key:'k',freeTier:'true',config:CFG,ttsImpl});
  assert.equal(chamadas.length,1);assert.equal(chamadas[0].o.freeTierConfirmed,true);assert.equal(chamadas[0].o.model,CFG.modelo);
  assert.equal(readFileSync(join(d,'voz','voz.pcm')).length,4800);assert.equal(JSON.parse(readFileSync(join(d,'voz','meta.json'))).voice,'Achird');assert.equal(m.bytes,4800);
  const nunca=async()=>{throw Error('não deveria chamar o TTS');};
  await assert.rejects(gerarVoz({pedidoPath:ped,outDir:d,key:'',freeTier:'true',config:CFG,ttsImpl:nunca}),/ensaio_sem_chave/,'environment sem segredo = falha fechada');
  await assert.rejects(gerarVoz({pedidoPath:ped,outDir:d,key:'k',freeTier:'false',config:CFG,ttsImpl:nunca}),/ensaio_nivel_gratuito_nao_confirmado/);
  writeFileSync(ped,'x'.repeat(20001));await assert.rejects(gerarVoz({pedidoPath:ped,outDir:d,key:'k',freeTier:'true',config:CFG,ttsImpl:nunca}),/ensaio_pedido_grande_demais/);
  writeFileSync(ped,JSON.stringify({texto:TXT,voz:'Achird',modelo:CFG.modelo}));
  await assert.rejects(gerarVoz({pedidoPath:ped,outDir:d,key:'k',freeTier:'true',config:CFG,ttsImpl:async()=>({pcm:Buffer.alloc(0),voice:'Achird',model:CFG.modelo})}),/ensaio_voz_invalida/);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('júri: só PNG 540x960 e pedido JSON válidos; avaliador do gh-pages; falha de áudio vira DESCARTADO; sem chave = falha',async()=>{
 assert.ok(lerQuadro(png()));
 for(const b of [png(1080,1920),png(720,1280),Buffer.from('GIF89a'+'x'.repeat(40)),png(1080,1920,4e6)])assert.throws(()=>lerQuadro(b),/ensaio_quadro/);
 const base={quadros:['juri-0.png'],criativo:{},padrao:{},medicao:{},permitidos:{},audio:[]};
 assert.ok(validarPedidoJuri(base));
 for(const p of [{...base,quadros:[]},{...base,quadros:Array(QUADROS_MAX+1).fill('juri-0.png')},{...base,quadros:['../segredo.png']},{...base,quadros:['juri-0.png;rm']},{...base,criativo:null},{...base,audio:'x'}])
  assert.throws(()=>validarPedidoJuri(p),/ensaio_juri/);
 const d=tmp();try{writeFileSync(join(d,'juri-0.png'),png());writeFileSync(join(d,'juri-pedido.json'),JSON.stringify({...base,audio:['voice_speed']}));
  let recebido=null;const av=await julgar({dir:d,key:'k',avaliarImpl:async a=>{recebido=a;return {decisao:'APROVADO',aprovado:true,nota_geral:9.6,motivos:[],juri:{notas:{}}};}});
  assert.equal(recebido.key,'k');assert.equal(recebido.quadrosPng.length,1);assert.equal(av.decisao,'DESCARTADO','falha de áudio medida no render reprova');assert.deepEqual(av.motivos,['audio:voice_speed']);
  assert.ok(existsSync(join(d,'resultado.json')));
  await assert.rejects(julgar({dir:d,key:'',avaliarImpl:async()=>{throw Error('não');}}),/ensaio_sem_chave/);
 }finally{rmSync(d,{recursive:true,force:true});}
});
