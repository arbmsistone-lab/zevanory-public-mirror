// v3.4 (NC-V34-02/03): alinhamento por frase com eixo único. B1–B6 sem ferramentas externas (a parte com ffmpeg real
// está em tests/media/shorts-v2-media.test.mjs).
import {readTextNormalized} from './helpers/text.mjs';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const TMP_B9=mkdtempSync(join(tmpdir(),'frases-b9-'));
import test from 'node:test';import assert from 'node:assert/strict';
import {lerSilencios,escolherFronteiras,particionar,vozNoTrecho,validarTrecho,alinharPorFrases,energiaDb,CAUDA_DB,fronteirasPorAlinhamento} from '../scripts/shorts-v3/frases.mjs';
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
test('B7 (ensaio 43624128303): pausas de dois-pontos DENTRO das falas mais longas que as fronteiras reais não deslocam os cortes',async()=>{
 const falas=JSON.parse(readTextNormalized('data/shorts-v3/lcx.json')).falas.map(f=>f.texto);
 assert.equal(falas.length,10);
 const sil=t=>(t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').match(/[aeiouy]+/g)||[]).length;
 // ritmo irregular por fala (TTS real varia ±25%), fronteiras reais curtas (0,22–0,40 s) e pausas internas longas
 // (0,55–0,70 s) logo após os dois-pontos/vírgula de "venda:", "máximo:", "Caixa:" e "reais,".
 const ritmo=[0.17,0.13,0.15,0.19,0.14,0.16,0.13,0.18,0.15,0.17],entre=[0.3,0.22,0.4,0.25,0.24,0.35,0.3,0.28,0.26];
 const internas={1:['venda:',0.6],6:['máximo:',0.7],8:['Caixa:',0.55]};
 let t=0.3;const S=[{ini:0,fim:0.3}],reais=[];
 falas.forEach((f,k)=>{
  const ws=f.split(/\s+/);
  for(const w of ws){t+=sil(w)*ritmo[k];const i=internas[k];if(i&&w===i[0]){S.push({ini:t,fim:t+i[1]});t+=i[1];}
   if(k===8&&w==='reais,'){S.push({ini:t,fim:t+0.5});t+=0.5;}}
  if(k<9){S.push({ini:t,fim:t+entre[k]});reais.push(t+entre[k]/2);t+=entre[k];}
 });
 const DUR=t+0.4;S.push({ini:t,fim:DUR});
 const f=escolherFronteiras({silencios:S,duracao:DUR,falas});
 assert.equal(f.ok,true,f.motivo);
 assert.deepEqual(f.cortes.map(c=>+c.toFixed(3)),reais.map(c=>+c.toFixed(3)));
 // e o critério antigo ("as 9 pausas mais longas") de fato erraria neste áudio:
 const internosS=S.filter(s=>s.ini>0.05&&s.fim<DUR-0.05),top=[...internosS].sort((a,b)=>(b.fim-b.ini)-(a.fim-a.ini)).slice(0,9);
 assert.ok(top.some(s=>!reais.some(r=>Math.abs((s.ini+s.fim)/2-r)<1e-9)),'cenário precisa reproduzir a falha original');
 // sem a pausa real de uma fronteira (falas coladas), não há atribuição honesta: volta ao alinhamento inteiro
 const semUma=S.filter(s=>Math.abs((s.ini+s.fim)/2-reais[4])>1e-9);
 assert.equal(escolherFronteiras({silencios:semUma,duracao:DUR,falas}).ok,false);
 assert.match(escolherFronteiras({silencios:semUma,duracao:DUR,falas}).pausas,/^\d/,'diagnóstico das pausas medidas vai para o log');
});
test('B8 (ensaios 43625938908/43635724926): sobra de 0,61 s no fim da pergunta só passa se for CAUDA (energia baixa); fala perdida reprova',()=>{
 const sr=16000,seg=(n,amp)=>Array.from({length:Math.round(n*sr)},(_,i)=>Math.round(amp*Math.sin(i/sr*2*Math.PI*180)));
 // fala 0–1,0 s em volume de fala; depois 0,7 s de decaimento (−26 dB abaixo) ou de fala de verdade (palavra perdida)
 const comCauda=Int16Array.from([...seg(1.0,9000),...seg(0.7,450)]),semPalavra=Int16Array.from([...seg(1.0,9000),...seg(0.7,8500)]);
 const t={inicio:0,fim:1.7},voz={on:0,off:1.7},palavras=[{word:'Sua',start:0,end:0.4},{word:'desaparece?',start:0.45,end:1.0}];
 assert.ok(energiaDb(comCauda,sr,1.0,1.7)<=energiaDb(comCauda,sr,0,1.0)-CAUDA_DB);
 const info=[];assert.deepEqual(validarTrecho({palavras,trecho:t,voz,energia:(a,b)=>energiaDb(comCauda,sr,a,b),info}),[]);assert.match(info[0],/cauda/);
 assert.match(validarTrecho({palavras,trecho:t,voz,energia:(a,b)=>energiaDb(semPalavra,sr,a,b)}).join(),/fim_da_fala_sem_palavra:0\.70/,'sobra com volume de fala = palavra perdida');
 assert.match(validarTrecho({palavras,trecho:t,voz}).join(),/fim_da_fala_sem_palavra/,'sem medida de energia não há presunção de cauda');
 // cauda longa demais (> CAUDA_MAX_S) reprova mesmo com energia baixa
 const longa=Int16Array.from([...seg(1.0,9000),...seg(1.5,450)]);
 assert.match(validarTrecho({palavras,trecho:{inicio:0,fim:2.5},voz:{on:0,off:2.5},energia:(a,b)=>energiaDb(longa,sr,a,b)}).join(),/fim_da_fala_sem_palavra/);
 // fala final: a mesma regra, com o nome de motivo da fala final
 assert.match(validarTrecho({palavras,trecho:t,voz,final:true,energia:(a,b)=>energiaDb(semPalavra,sr,a,b)}).join(),/voz_final_ausente/);
});
test('B9 (ensaio 43637492214): TTS emenda frases sem pausa -> fronteiras guiadas pelo alinhamento inteiro + menor energia; realinha por trecho',async()=>{
 const falas=JSON.parse(readTextNormalized('data/shorts-v3/lcx.json')).falas.map(f=>f.texto);
 const sr=1000,tam=falas.map(f=>f.split(/\s+/).length);
 // linha do tempo real: 0,3 s de silêncio, cada palavra 0,3 s; entre falas, vale curto de 0,06 s (abaixo do mínimo de pausa)
 let t=0.3;const inteiras=[],fronteiras=[],faixas=[];
 falas.forEach((f,k)=>{const ini=t;for(const w of f.split(/\s+/)){inteiras.push({word:w,start:t,end:t+0.3});t+=0.3;}faixas.push([ini,t]);if(k<9){fronteiras.push(t+0.03);t+=0.06;}});
 const dur=t+0.4,amostras=new Int16Array(Math.round(dur*sr));
 for(const [a,b] of faixas)for(let i=Math.round(a*sr);i<Math.round(b*sr);i++)amostras[i]=8000*((i%7)-3)/3|0;
 // só as 4 primeiras fronteiras têm pausa medida; o resto o TTS emendou
 const silencios=[{ini:0,fim:0.3},...fronteiras.slice(0,4).map(c=>({ini:c-0.1,fim:c+0.1})),{ini:t,fim:dur}];
 // alinhamento inteiro com instantâneas no meio das frases e as bordas um pouco deslocadas (±0,1 s)
 const ruidoso=inteiras.map((w,i)=>i%11===5?{...w,end:w.start}:{...w,start:w.start+0.05,end:w.end-0.05});
 const en=(a,b)=>energiaDb(amostras,sr,a,b);
 const g=fronteirasPorAlinhamento({palavras:ruidoso,falas,silencios,duracao:dur,energia:en});
 assert.equal(g.ok,true,g.motivo);g.cortes.forEach((c,k)=>assert.ok(Math.abs(c-fronteiras[k])<=0.04,`corte ${k+1}: ${c} ~ ${fronteiras[k]}`));
 assert.match(fronteirasPorAlinhamento({palavras:ruidoso.slice(1),falas,silencios,duracao:dur,energia:en}).motivo,/inteiro_contagem/);
 // orquestração: pausas insuficientes -> usa o inteiro UMA vez -> realinha cada trecho -> ok com via=alinhamento_inteiro
 let chamadas=0;const notas=[];
 const deps={silenciosDe:()=>silencios,pcmDe:()=>({amostras,sr}),gravarTrecho:()=>{},
  alinharTrecho:async(arq,texto)=>{const k=+/frase-(\d+)/.exec(arq)[1]-1,ini=g.cortes[k-1]??0,base=inteiras.findIndex(w=>w===inteiras[tam.slice(0,k).reduce((a,b)=>a+b,0)]);
   return {segments:[{words:inteiras.slice(base,base+tam[k]).map(w=>({word:w.word,start:w.start-ini,end:w.end-ini}))}]};}};
 const r=await alinharPorFrases({wav:'x',falas,duracao:dur,base:join(TMP_B9,'b9'),deps,note:m=>notas.push(m),inteiro:async()=>{chamadas++;return {segments:[{words:ruidoso}]};}});
 assert.equal(r.ok,true,r.motivo);assert.equal(r.via,'alinhamento_inteiro');assert.equal(chamadas,1);
 assert.equal(r.alignment.segments[0].words.length,inteiras.length);assert.ok(notas.some(n=>/pausas_insuficientes/.test(n)));
 // sem o alinhamento inteiro disponível, falha fechada como antes
 assert.equal((await alinharPorFrases({wav:'x',falas,duracao:dur,base:join(TMP_B9,'b9'),deps})).ok,false);
});
