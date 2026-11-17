// GPT-6 #1054 (15/11): CTA do v3 "link do perfil" (links na descrição de Shorts não são clicáveis). A mesma frase vale na
// validação do roteiro (antes de qualquer TTS), no tempo do cartão final e na checagem de qualidade — e o v2 não muda.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
import {CTA_V3,ctaFalado,validarSpecV3,carregarSpec} from '../scripts/shorts-v3/render.mjs';
import {CTA,shortTiming,quality} from '../scripts/shorts-v2/core.mjs';
const W=(t,ini=0,passo=0.33)=>t.split(/\s+/).map((w,i)=>({word:w,start:ini+i*passo,end:ini+i*passo+0.3}));
test('roteiro real do v3 valida; CTA antigo, ausente ou trocado reprova (v3_spec_invalida)',async()=>{
 const spec=await carregarSpec('data/shorts-v3/lcx.json');assert.equal(spec.falas.at(-1).texto,CTA_V3+'.');
 assert.equal(CTA_V3,'Kit Lucro e Caixa no link do perfil');assert.doesNotMatch(CTA_V3,/descri/i);
 for(const fim of [CTA+'.','Kit completo no link da descrição.',CTA_V3,'Link na bio.'])
  assert.throws(()=>validarSpecV3({...spec,falas:[...spec.falas.slice(0,-1),{...spec.falas.at(-1),texto:fim}]}),/v3_spec_invalida/,fim);
});
test('tempo do cartão final com o CTA do v3 (8 palavras ~2,7 s cabe em 3,5 s com cauda 0,5–2,0); v2 inalterado',()=>{
 // ritmo real de palavras curtas (~0,28 s): o CTA novo tem 11 sílabas, quase o mesmo que o antigo (10), que sempre coube
 const roteiro='Sua loja vende mas o dinheiro some '+CTA_V3,w=W(roteiro,24,0.28),fimVoz=w.at(-1).end+0.4;
 const t=shortTiming(fimVoz,w,CTA_V3);assert.equal(t.firstCta,w[w.length-8].start);assert.ok(t.tail>=0.5&&t.tail<=2.0,`cauda ${t.tail}`);
 // v2: padrão continua sendo o CTA antigo (6 palavras)
 const w2=W('Sua loja vende '+CTA,26),t2=shortTiming(w2.at(-1).end+0.4,w2);assert.equal(t2.firstCta,w2[w2.length-6].start);
 // CTA lento demais (10 palavras) estoura o cartão: falha explícita, não silenciosa
 const longo='O kit Lucro e Caixa está no link do perfil',wl=W('a b '+longo,26,0.33);assert.throws(()=>shortTiming(wl.at(-1).end+0.4,wl,longo),/cta_alignment_failed/);
});
test('qualidade confere o CTA FALADO (palavras alinhadas) contra o do v3; o v2 continua contra o seu',()=>{
 assert.equal(ctaFalado(W('blá '+CTA_V3+'.')),CTA_V3,'pontuação e caixa não importam');
 assert.equal(ctaFalado(W('blá kit lucro e caixa no link do perfíl')),CTA_V3,'acento não importa');
 assert.equal(ctaFalado(W('blá '+CTA)),'cta_falado_divergente');assert.equal(ctaFalado([]),'cta_falado_divergente');
 const q={ppm:170,internalSilence:0.3,clipping:false,voiceLufs:-16,duration:32,videoDuration:32,musicDetected:true,duckingDb:10,musicBedLufs:-23,voiceMusicDb:17,mixLufs:-14.5,truePeak:-1.5,ctaSeconds:3.5};
 assert.ok(!quality({...q,cta:CTA_V3},{cta:CTA_V3}).reasons.includes('cta'));
 assert.ok(quality({...q,cta:'cta_falado_divergente'},{cta:CTA_V3}).reasons.includes('cta'));
 assert.ok(!quality({...q,cta:CTA}).reasons.includes('cta'),'v2 padrão inalterado');assert.ok(quality({...q,cta:CTA_V3}).reasons.includes('cta'),'v2 não aceita o CTA do v3');
 const src=readTextNormalized('scripts/shorts-v3/render.mjs');
 assert.match(src,/shortTiming\(voiceDuration,words,CTA_V3\)/);assert.match(src,/cta:ctaFalado\(words\)/);assert.match(src,/quality\(metrics,\{cta:CTA_V3\}\)/);
});
test('o pedido de voz só sai depois de validar o roteiro (roteiro inválido nunca consome TTS)',()=>{
 const src=readTextNormalized('scripts/shorts-v3/ensaio-fases.mjs');
 const b=src.slice(src.indexOf('async function base('),src.indexOf('export async function pedido('));
 assert.match(b,/const spec=await carregarSpec\(ATIVO_V3\[slot\]\)/);assert.doesNotMatch(b,/JSON\.parse\(await readFile\(join\(ROOT,ATIVO_V3/);
 assert.match(src,/export async function pedido\(out,slot\)\{\n const \{config,texto\}=await base\(slot\);/);
});
test('legenda nunca divide o nome do produto do CTA (o avaliador reprovaria "Lucro" sem "e Caixa"), em qualquer ritmo',async()=>{
 const {gruposV3,gruposCurtosV3,legendasV3,nomesProdutoV3}=await import('../scripts/shorts-v3/render.mjs');
 const {conferirAfirmacoes}=await import('../scripts/criativos/afirmacoes.mjs');
 const lucro=txt=>conferirAfirmacoes({falas:[],telas:[txt],permitidos:{reais:[],pct:[],outros:[]}}).includes('lucro_fora_do_nome_do_produto');
 assert.ok(lucro('Kit Lucro e'),'a regra do avaliador reprova o nome cortado');assert.ok(!lucro('Kit Lucro e Caixa'));
 const cta=CTA_V3.split(' ');assert.deepEqual(nomesProdutoV3(cta.map(word=>({word}))),[[0,4]]);
 // ritmos: uniforme, palavras curtas instantâneas, "Kit" muito rápido, fim arrastado
 const ritmos=[[.3,.3,.3,.3,.3,.3,.3,.3],[.25,.12,.08,.3,.12,.3,.1,.4],[.1,.35,.1,.35,.2,.3,.2,.5],[.4,.4,.15,.4,.2,.25,.2,.6]];
 for(const r of ritmos){let t=10;const w=cta.map((word,i)=>{const o={word:i===7?'perfil.':word,start:t,end:t+r[i]*0.8};t+=r[i];return o;});
  const g=gruposV3(w,[8],t+0.3),textos=g.map(([a,b])=>w.slice(a,b).map(x=>x.word).join(' '));
  assert.equal(textos[0],'Kit Lucro e Caixa',JSON.stringify(textos));assert.ok(textos.every(x=>!lucro(x)),JSON.stringify(textos));
  assert.ok(g.every(([a,b])=>b-a<=3||(a===0&&b===4)),'só o nome pode ter 4 palavras');
  const ass=legendasV3(w,[8],t+0.3).replace(/\{[^}]*\}/g,'');assert.ok(ass.includes('Kit Lucro e Caixa'));
  assert.deepEqual(gruposCurtosV3(w,[8],t+0.3),[]);}
 // fora do nome, o limite de 3 palavras continua
 const outro='Sua loja vende mas o dinheiro some'.split(' ').map((word,i)=>({word,start:i*.3,end:i*.3+.2}));
 assert.ok(gruposV3(outro,[7],2.4).every(([a,b])=>b-a<=3));
});
test('sincronia quadro a quadro: fronteiras das cenas quantizadas no absoluto (sem acúmulo); o cartão do CTA entra no quadro da 1ª palavra',async()=>{
 const {quadrosPorCena}=await import('../scripts/shorts-v3/render.mjs');
 // 10 cenas com inícios fora da grade de 1/30 s (como os tempos reais do alinhador)
 const inicios=[0,2.81,6.26,9.30,11.33,15.13,18.31,21.91,24.81,29.13],dur=29.13+3.5,cenas=inicios.map(start=>({start}));
 const n=quadrosPorCena(cenas,dur);let acc=0;
 inicios.forEach((t,i)=>{assert.equal(acc,Math.round(t*30),'cena '+i+' começa no quadro da fala');acc+=n[i];});
 assert.equal(acc,Math.round(dur*30),'total = duração');
 // o método antigo (ceil por cena) atrasava a última cena
 let velho=0;for(let i=0;i<inicios.length-1;i++)velho+=Math.ceil((inicios[i+1]-inicios[i])*30);assert.ok(velho>Math.round(29.13*30),'premissa: o acúmulo existia');
 assert.throws(()=>quadrosPorCena([{start:0},{start:0.01}],1),/v3_cena_sem_quadros/);
 const src=readTextNormalized('scripts/shorts-v3/render.mjs');assert.match(src,/trim=end_frame=\$\{nq\[i\]\}/);
});
