// v3.4 (NC-V34-02/03): alinhamento por frase com eixo único. B1–B6 sem ferramentas externas (a parte com ffmpeg real
// está em tests/media/shorts-v2-media.test.mjs).
import test from 'node:test';import assert from 'node:assert/strict';
import {lerSilencios,escolherFronteiras,particionar,vozNoTrecho,validarTrecho,alinharPorFrases} from '../scripts/shorts-v3/frases.mjs';
const FALAS=['Sua loja vende muito.','O caixa some.','Kit completo no link da descrição.'];
// voz: fala 0–2,0 s | pausa 2,0–2,4 | fala 2,4–3,6 | pausa 3,6–4,0 | fala 4,0–6,4 | silêncio final 6,4–6,8
const SIL=[{ini:2.0,fim:2.4},{ini:3.6,fim:4.0},{ini:6.4,fim:6.8}],DUR=6.8;
test('B0: lê o silencedetect do ffmpeg (inclusive silêncio aberto no fim)',()=>{
 assert.deepEqual(lerSilencios('[silencedetect] silence_start: 2\n[silencedetect] silence_end: 2.4 | silence_duration: 0.4\nsilence_start: 6.4\n',6.8),[{ini:2,fim:2.4},{ini:6.4,fim:6.8}]);
});
test('B1: escolhe as N−1 pausas internas, compatíveis com o roteiro; corte no meio de cada pausa',()=>{
 const f=escolherFronteiras({silencios:[...SIL,{ini:1.0,fim:1.13}],duracao:DUR,falas:FALAS});
 assert.equal(f.ok,true,f.motivo);assert.deepEqual(f.cortes.map(c=>+c.toFixed(2)),[2.2,3.8]);
});
test('B2: pausas insuficientes, fronteira fora do ponto esperado ou trecho curto => volta ao alinhamento inteiro',()=>{
 assert.match(escolherFronteiras({silencios:[SIL[0],SIL[2]],duracao:DUR,falas:FALAS}).motivo,/pausas_insuficientes/);
 // pausa longa no meio da 1ª fala (respiração) em vez da fronteira real: incompatível com o roteiro
 assert.match(escolherFronteiras({silencios:[{ini:0.3,fim:0.9},{ini:3.6,fim:4.0},SIL[2]],duracao:DUR,falas:FALAS}).motivo,/fronteira_incompativel:1/);
});
test('B3: partição em amostras é exata (soma = total, sem lacuna nem sobreposição) e o eixo global é contínuo',()=>{
 const sr=48000,total=Math.round(DUR*sr)+7,t=particionar(total,sr,[2.2,3.8]);
 assert.equal(t.reduce((s,x)=>s+(x.b-x.a),0),total);assert.equal(t[0].a,0);assert.equal(t.at(-1).b,total);
 for(let k=1;k<t.length;k++)assert.equal(t[k].a,t[k-1].b);
 assert.throws(()=>particionar(total,sr,[3.8,2.2]),/particao_invalida/);
});
test('B4: trecho precisa cobrir a fala medida; fala final sem palavra instantânea; palavra fora do trecho reprova',()=>{
 const t={inicio:3.8,fim:DUR},voz=vozNoTrecho(SIL,t);assert.deepEqual([voz.on,voz.off],[4.0,6.4]);
 const ok=[{word:'Kit',start:4.0,end:4.3},{word:'descrição.',start:5.8,end:6.35}];
 assert.deepEqual(validarTrecho({palavras:ok,trecho:t,voz,final:true}),[]);
 assert.match(validarTrecho({palavras:[ok[0],{word:'link',start:4.4,end:5.0}],trecho:t,voz,final:true}).join(),/voz_final_ausente/,'TTS/alinhador deixou o fim da fala sem palavra');
 assert.match(validarTrecho({palavras:[ok[0],{word:'descrição.',start:6.3,end:6.3}],trecho:t,voz,final:true}).join(),/fala_final_com_palavra_instantanea/);
 assert.match(validarTrecho({palavras:[{word:'Kit',start:3.5,end:3.9},ok[1]],trecho:t,voz}).join(),/palavra_fora_do_trecho/);
});
test('B5: orquestração — tempos = alinhador do trecho + início do trecho; palavra faltando ou trocada volta ao inteiro',async()=>{
 const sr=1000,amostras=new Int16Array(Math.round(DUR*sr)),grav=[];
 const porFala={[FALAS[0]]:[['Sua',0,.4],['loja',.4,.8],['vende',.8,1.3],['muito.',1.3,1.95]],[FALAS[1]]:[['O',.25,.5],['caixa',.5,1.0],['some.',1.0,1.55]],
  [FALAS[2]]:[['Kit',.25,.6],['completo',.6,1.1],['no',1.1,1.3],['link',1.3,1.7],['da',1.7,1.9],['descrição.',1.9,2.55]]};
 const deps=(mapa)=>({silenciosDe:()=>SIL,pcmDe:()=>({amostras,sr}),gravarTrecho:(a,x,y,s,arq)=>grav.push([arq,x,y]),alinharTrecho:async(arq,texto)=>({segments:[{words:mapa[texto].map(([word,start,end])=>({word,start,end}))}]})});
 const r=await alinharPorFrases({wav:'v.wav',falas:FALAS,duracao:DUR,base:'b',deps:deps(porFala)});
 assert.equal(r.ok,true,r.motivo);const w=r.alignment.segments[0].words;
 assert.equal(w.length,13);assert.deepEqual([w[4].word,+w[4].start.toFixed(3)],['O',2.45]);assert.deepEqual([w.at(-1).word,+w.at(-1).end.toFixed(3)],['descrição.',6.35]);
 assert.deepEqual(grav.map(g=>[g[1],g[2]]),[[0,2200],[2200,3800],[3800,6800]],'trechos em índices de amostra');
 const falta={...porFala,[FALAS[2]]:porFala[FALAS[2]].slice(0,5)};
 assert.equal((await alinharPorFrases({wav:'v.wav',falas:FALAS,duracao:DUR,base:'b',deps:deps(falta)})).ok,false,'palavra omitida');
 const trocada={...porFala,[FALAS[1]]:[['O',.25,.5],['cofre',.5,1.0],['some.',1.0,1.55]]};
 assert.equal((await alinharPorFrases({wav:'v.wav',falas:FALAS,duracao:DUR,base:'b',deps:deps(trocada)})).ok,false,'palavra trocada');
});
test('B6: o v2 não usa o alinhamento por frase',async()=>{
 const {readTextNormalized}=await import('./helpers/text.mjs');
 assert.doesNotMatch(readTextNormalized('scripts/shorts-v2/render.mjs'),/frases\.mjs|alinharPorFrases/);
 assert.match(readTextNormalized('scripts/shorts-v3/render.mjs'),/alinharPorFrases\(/);
});
