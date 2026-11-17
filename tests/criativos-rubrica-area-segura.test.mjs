// Contra-auditoria GPT-6 (15/11, ensaio 43774298571: legibilidade 7,8 — "espaço vazio no terço inferior", que é a faixa
// reservada à interface do Shorts): o critério de legibilidade e o prompt dizem ONDE o vazio conta. O fundo livre nas
// faixas reservadas (y>=1470, x>=940) não reduz a nota; vazio que prejudique a composição dentro da área útil e conteúdo
// essencial nas faixas reservadas continuam reduzindo. Pesos, nota mínima e demais critérios iguais; a rubrica anterior é
// recusada; e o prompt EFETIVAMENTE enviado pelo caminho protegido do ensaio leva o texto novo.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CRITERIOS,NOTA_MINIMA,montarPadrao,validarPadrao} from '../scripts/criativos/padrao.mjs';
import {promptJuri} from '../scripts/criativos/avaliador.mjs';
import {julgar} from '../scripts/ci/ensaio-juri.mjs';
const LEG_ANTIGA='Todo texto é legível no celular, com hierarquia clara, sem quadro vazio, dentro da área segura (sem conteúdo essencial nos 450 px de baixo e 140 px à direita)?';
const png=()=>{const b=Buffer.alloc(33);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12,'latin1');b.writeUInt32BE(540,16);b.writeUInt32BE(960,20);return b;};
test('rubrica: legibilidade avalia o vazio só dentro da área útil; faixas reservadas livres não reduzem; invasão reduz; pesos e mínimo iguais',()=>{
 const l=CRITERIOS.find(c=>c.id==='legibilidade').pergunta;
 assert.match(l,/dentro da área segura do projeto \(acima de y=1470 e à esquerda de x=940\)/);
 assert.match(l,/fundo livre nas faixas reservadas à interface \(abaixo de y=1470 e à direita de x=940\) não reduz a nota/);
 assert.match(l,/Espaços vazios que prejudiquem a composição dentro da área útil/);assert.match(l,/conteúdo essencial que invada as faixas reservadas reduzem a nota/);
 assert.doesNotMatch(l,/sem quadro vazio/);
 assert.deepEqual(CRITERIOS.map(c=>[c.id,c.peso]),[['gancho',0.25],['legibilidade',0.15],['prova',0.25],['oferta',0.2],['marca',0.15]]);
 assert.equal(NOTA_MINIMA,9.5);
 const p=promptJuri(montarPadrao({evidencia:[],geradoEm:'2026-11-15T12:00:00Z'}));
 assert.match(p,/faixa abaixo de y=1470 e a região à direita de x=940 podem ser ocupadas por elementos da interface/);
 assert.match(p,/Espaços vazios injustificados dentro da área útil continuam sendo defeitos de composição; o fundo livre nas faixas reservadas à interface não reduz nenhuma nota\./);
});
test('compatibilidade: padrão do render aceito; a rubrica de legibilidade anterior é recusada (o PR do vídeo precisa incorporar esta base)',()=>{
 const p=JSON.parse(JSON.stringify(montarPadrao({evidencia:[],geradoEm:'2026-11-15T12:00:00Z'})));
 assert.equal(validarPadrao(p),p);
 const antiga=p.criterios.map(c=>c.id==='legibilidade'?{...c,pergunta:LEG_ANTIGA}:c);
 assert.throws(()=>validarPadrao({...p,criterios:antiga}),/padrao_invalido/);
});
test('caminho protegido do ensaio: o prompt enviado ao Gemini (simulado) traz o critério novo; padrão antigo nunca chega ao Gemini',async()=>{
 const d=mkdtempSync(join(tmpdir(),'rub-area-'));const original=globalThis.fetch;const corpos=[];
 globalThis.fetch=async(url,init)=>{corpos.push({url,body:JSON.parse(init.body)});return {status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({notas:{gancho:9.6,legibilidade:9.6,prova:9.6,oferta:9.6,marca:9.6},problemas:[],melhorias:[]})}]}}]})};};
 try{
  const padrao=montarPadrao({evidencia:[],geradoEm:'2026-11-15T12:00:00Z'});
  writeFileSync(join(d,'juri-0.png'),png());
  writeFileSync(join(d,'juri-pedido.json'),JSON.stringify({quadros:['juri-0.png'],criativo:{sku:'ZEV-LCX-011'},padrao,medicao:{},permitidos:{reais:[],pct:[]},audio:[]}));
  await julgar({dir:d,key:'chave-simulada'});
  assert.equal(corpos.length,1);
  const prompt=corpos[0].body.contents[0].parts[0].text;
  assert.ok(prompt.includes('- legibilidade: '+CRITERIOS.find(c=>c.id==='legibilidade').pergunta),'critério novo no prompt enviado');
  assert.ok(!prompt.includes(LEG_ANTIGA),'texto antigo ausente');
  const velho={...padrao,criterios:padrao.criterios.map(c=>c.id==='legibilidade'?{...c,pergunta:LEG_ANTIGA}:c)};
  writeFileSync(join(d,'juri-pedido.json'),JSON.stringify({quadros:['juri-0.png'],criativo:{sku:'ZEV-LCX-011'},padrao:velho,medicao:{},permitidos:{reais:[],pct:[]},audio:[]}));
  const av2=await julgar({dir:d,key:'chave-simulada'});
  assert.equal(corpos.length,1,'nenhuma chamada nova ao Gemini');assert.equal(av2.decisao,'DESCARTADO');assert.match(String(av2.erro),/padrao_invalido/);
 }finally{globalThis.fetch=original;rmSync(d,{recursive:true,force:true});}
});
