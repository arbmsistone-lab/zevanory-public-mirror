// Contra-auditoria GPT-6 (15/11, ensaio 43731076486): a rubrica do júri pedia "chamada clara para a descrição", o que
// contradiz o YouTube (em Shorts, URLs externas na descrição/comentários não são clicáveis; o link clicável fica no
// perfil do canal). Aqui: o critério de oferta e o prompt usam a regra do perfil; pesos, nota mínima e demais critérios
// iguais; o padrão produzido pelo render (montarPadrao, ida e volta em JSON como no juri-pedido.json) é aceito pelo júri
// da base; critérios divergentes (inclusive a rubrica antiga) continuam recusados; e o prompt EFETIVAMENTE enviado
// pelo caminho protegido do ensaio (scripts/ci/ensaio-juri.mjs -> avaliar -> gerarJSON) é capturado com Gemini simulado.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CRITERIOS,NOTA_MINIMA,montarPadrao,validarPadrao} from '../scripts/criativos/padrao.mjs';
import {promptJuri,FATO_LINK_SHORTS} from '../scripts/criativos/avaliador.mjs';
import {julgar} from '../scripts/ci/ensaio-juri.mjs';
const png=()=>{const b=Buffer.alloc(33);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12,'latin1');b.writeUInt32BE(540,16);b.writeUInt32BE(960,20);return b;};
test('rubrica: oferta pede o link clicável no perfil (não a descrição); pesos, mínimo e demais critérios inalterados',()=>{
 const o=CRITERIOS.find(c=>c.id==='oferta');
 assert.match(o.pergunta,/link clicável no perfil do canal/);assert.doesNotMatch(o.pergunta,/descri/i);
 assert.match(o.pergunta,/benefício/);assert.match(o.pergunta,/nome do kit/);assert.match(o.pergunta,/preço oficial/);assert.match(o.pergunta,/prazo aplicável/);
 assert.deepEqual(CRITERIOS.map(c=>[c.id,c.peso]),[['gancho',0.25],['legibilidade',0.15],['prova',0.25],['oferta',0.2],['marca',0.15]]);
 assert.equal(NOTA_MINIMA,9.5);
 assert.match(FATO_LINK_SHORTS,/descrição e nos comentários NÃO são clicáveis/);assert.match(FATO_LINK_SHORTS,/perfil do canal/);
});
test('compatibilidade: padrão do render (ida e volta em JSON) aceito pelo júri; critérios divergentes ou a rubrica antiga recusados',()=>{
 const p=JSON.parse(JSON.stringify(montarPadrao({evidencia:[],geradoEm:'2026-11-15T12:00:00Z'})));
 assert.equal(validarPadrao(p),p);assert.match(promptJuri(p),/link clicável no perfil do canal/);
 const antiga=p.criterios.map(c=>c.id==='oferta'?{...c,pergunta:'O final apresenta primeiro o benefício, depois nome do kit, preço oficial, garantia e chamada clara para a descrição?'}:c);
 for(const criterios of [antiga,p.criterios.slice(1),p.criterios.map(c=>c.id==='oferta'?{...c,peso:0.3}:c)])assert.throws(()=>validarPadrao({...p,criterios}),/padrao_invalido/);
});
test('caminho protegido do ensaio: o prompt enviado ao Gemini (simulado) traz a regra do perfil; padrão divergente nunca chega ao Gemini',async()=>{
 const d=mkdtempSync(join(tmpdir(),'rub-'));const original=globalThis.fetch;const corpos=[];
 globalThis.fetch=async(url,init)=>{corpos.push({url,body:JSON.parse(init.body)});return {status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({notas:{gancho:9.6,legibilidade:9.6,prova:9.6,oferta:9.6,marca:9.6},problemas:[],melhorias:[]})}]}}]})};};
 try{
  const padrao=montarPadrao({evidencia:[],geradoEm:'2026-11-15T12:00:00Z'});
  writeFileSync(join(d,'juri-0.png'),png());
  writeFileSync(join(d,'juri-pedido.json'),JSON.stringify({quadros:['juri-0.png'],criativo:{sku:'ZEV-LCX-011'},padrao,medicao:{},permitidos:{reais:[],pct:[]},audio:[]}));
  const av=await julgar({dir:d,key:'chave-simulada'});
  assert.equal(corpos.length,1);assert.match(corpos[0].url,/generativelanguage\.googleapis\.com/);
  const prompt=corpos[0].body.contents[0].parts[0].text;
  assert.ok(prompt.includes(FATO_LINK_SHORTS),'fato da plataforma no prompt');
  assert.ok(prompt.includes('- oferta: '+CRITERIOS.find(c=>c.id==='oferta').pergunta),'critério de oferta do perfil no prompt');
  assert.doesNotMatch(prompt,/chamada clara para a descrição/);
  assert.equal(corpos[0].body.contents[0].parts.length,2,'prompt + 1 quadro');
  assert.ok(av.juri&&av.juri.notas.oferta===9.6,'resposta simulada lida');
  // padrão com a rubrica antiga: recusado antes de qualquer chamada
  const velho={...padrao,criterios:padrao.criterios.map(c=>c.id==='oferta'?{...c,pergunta:'... chamada clara para a descrição?'}:c)};
  writeFileSync(join(d,'juri-pedido.json'),JSON.stringify({quadros:['juri-0.png'],criativo:{sku:'ZEV-LCX-011'},padrao:velho,medicao:{},permitidos:{reais:[],pct:[]},audio:[]}));
  const av2=await julgar({dir:d,key:'chave-simulada'});
  assert.equal(corpos.length,1,'nenhuma chamada nova ao Gemini');assert.equal(av2.decisao,'DESCARTADO');assert.match(String(av2.erro),/padrao_invalido/);
 }finally{globalThis.fetch=original;rmSync(d,{recursive:true,force:true});}
});
