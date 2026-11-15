// GPT-6 #1054 (15/11): prova do FLUXO COMPLETO do v3, sem consumir Gemini. O roteiro REAL (data/shorts-v3/lcx.json) passa
// pela validação, o render v3 inteiro roda (quadros, ffmpeg, mixagem, loudnorm, legenda, medir.py com OCR real) com:
//   - voz simulada: um tom por palavra, com pausas entre frases, em tempos conhecidos (nenhuma chamada de TTS);
//   - alinhador simulado que devolve exatamente esses tempos;
//   - júri simulado com nota alta, passando pelo avaliador DESTE código (as checagens objetivas são as reais).
// Prova: o cartão final entra junto com a fala nova do CTA ("link do perfil"); o áudio passa (incl. 'cta');
// o avaliador aprova com tudo legível e REPROVA se a medição real de uma célula for adulterada para < 56 px.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {renderV3,CTA_V3,carregarSpec} from '../../scripts/shorts-v3/render.mjs';
import {avaliar} from '../../scripts/criativos/avaliador.mjs';
import {CTA_CARD_SECONDS} from '../../scripts/shorts-v2/core.mjs';
// Ritmo calibrado no ensaio real 43672792852 (voz Achird, 176 ppm após atempo): a última fala (6 palavras) ocupou ~2,2 s do
// início ao fim do WAV (~0,30 s/palavra + ~0,3 s de silêncio final); pausas entre frases de 0,15–0,50 s. Total < 176 ppm,
// então o atempo fica em 1 e os tempos do alinhador simulado valem no WAV processado.
const SR=24000,PASSO=0.30,TOM=0.22,PAUSA=0.35,SILENCIO_FINAL=0.3;
function vozSimulada(falas){
 const words=[];let t=0.25;const blocos=[];
 falas.forEach((f,i)=>{const a=t;for(const w of f.split(/\s+/).filter(Boolean)){words.push({word:w,start:t,end:t+TOM});t+=PASSO;}blocos.push([a,t-PASSO+TOM]);if(i<falas.length-1)t+=PAUSA;});
 const pcm=Buffer.alloc(Math.round((t-PASSO+TOM+SILENCIO_FINAL)*SR)*2);
 // energia contínua dentro da frase (como fala: sílabas moduladas, sem silêncio entre palavras), com harmônicos
 for(const [a,b] of blocos)for(let i=Math.round(a*SR);i<Math.round(b*SR);i++){const k=i/SR,env=Math.min(1,(k-a)/0.03,(b-k)/0.03)*(0.65+0.35*Math.abs(Math.sin(Math.PI*(k-a)/PASSO)));pcm.writeInt16LE(Math.round(7000*env*(Math.sin(2*Math.PI*160*k)+0.5*Math.sin(2*Math.PI*320*k)+0.3*Math.sin(2*Math.PI*480*k))/1.8),i*2);}
 return {pcm,words};
}
const juriAlto=async()=>({status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({notas:{gancho:9.8,legibilidade:9.8,prova:9.8,oferta:9.8,marca:9.8},problemas:[],melhorias:[]})}]}}]})});
test('FLUXO v3 completo com roteiro real e voz simulada: CTA "link do perfil" sincronizado com o cartão; avaliador deste SHA aprova legível e reprova célula < 56 px',{timeout:1500000},async()=>{
 const spec=await carregarSpec('data/shorts-v3/lcx.json');assert.equal(spec.falas.at(-1).texto,CTA_V3+'.');
 const falas=spec.falas.map(f=>f.texto),{pcm,words}=vozSimulada(falas);
 const config=JSON.parse(readFileSync('data/shorts-padrao-v2.json','utf8'));
 const dir=mkdtempSync(join(tmpdir(),'v3-fluxo-'));let medicaoReal=null,entradaReal=null;const notas=[];
 try{
  const r=await renderV3('data/shorts-v3/lcx.json',join(dir,'short'),{geminiKey:'simulada',config,preview:true,
   synthesize:async(texto,voz,_k,o)=>{assert.equal(texto,falas.join(' '));return {pcm,voice:voz,model:o.model};},
   align:async()=>({segments:[{words}]}),
   oferta:async()=>({fonte:'https://vendas.zevanory.api.br/lucro-e-caixa',preco:147,versao:'sha256:simulada',lido_em:'2026-11-15T12:00:00Z'}),
   avaliarImpl:async a=>{entradaReal=a;medicaoReal=a.medicao;return avaliar({...a,fetchImpl:juriAlto,esperar:async()=>{}});},
   note:m=>notas.push(String(m))});
  assert.ok(existsSync(r.file),'MP4 gerado');
  // CTA: o cartão final (duration − 3,5 s) começa na 1ª palavra falada do CTA novo (8 palavras), com cauda 0,5–2,0 s
  const n=CTA_V3.split(/\s+/).length,primeiraCta=words[words.length-n];
  assert.equal(words.slice(-n).map(w=>w.word).join(' ').replace(/\.$/,''),CTA_V3);
  assert.ok(Math.abs((r.duration-CTA_CARD_SECONDS)-primeiraCta.start*1)<0.15,`cartão ${r.duration-CTA_CARD_SECONDS} x fala ${primeiraCta.start}`);
  assert.deepEqual(r.qc.audio.reasons,[],'áudio sem falhas (inclui a checagem do CTA falado) '+JSON.stringify(r.qc.metrics));
  assert.equal(r.qc.metrics.cta,CTA_V3,'CTA conferido nas palavras alinhadas');
  // avaliador DESTE código: medição real + júri simulado alto -> APROVADO; objetivas reais vazias
  assert.deepEqual(r.avaliacao.motivos,[],JSON.stringify(r.avaliacao.motivos));assert.equal(r.avaliacao.decisao,'APROVADO');
  const leg=medicaoReal.medidas.provasLegiveis;assert.equal(leg.length,4);assert.equal(entradaReal.criativo.celulasExigidas.length,4,'o render envia as 4 células exigidas pelo roteiro');assert.ok(leg.every(p=>p.legivel&&p.altura_px>=56),JSON.stringify(leg.map(p=>[p.valor,p.altura_px])));
  // a MESMA medição real, com uma célula adulterada para 40 px ou sem a lista: reprova mesmo com júri alto
  for(const [nome,md] of [['célula a 40 px',{...medicaoReal.medidas,provasLegiveis:leg.map((p,i)=>i===1?{...p,altura_px:40,legivel:false}:p)}],['célula a 40 px marcada legível',{...medicaoReal.medidas,provasLegiveis:leg.map((p,i)=>i===1?{...p,altura_px:40}:p)}],['sem medição de células',{...medicaoReal.medidas,provasLegiveis:undefined}],['3 das 4 células (uma retirada)',{...medicaoReal.medidas,provasLegiveis:leg.filter((_,i)=>i!==2)}],['duplicata no lugar de uma célula (contagem 4)',{...medicaoReal.medidas,provasLegiveis:leg.map((p,i)=>i===2?{...leg[1]}:p)}]]){
   // mesma entrada real do avaliador (quadros do MP4, permitidos, oferta), só a medida adulterada
   const reprovado=await avaliar({...entradaReal,medicao:{...entradaReal.medicao,medidas:md},fetchImpl:juriAlto,esperar:async()=>{}});
   assert.equal(reprovado.decisao,'DESCARTADO',nome);assert.ok(reprovado.motivos.includes('prova_ilegivel'),nome+': '+reprovado.motivos.join(','));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
