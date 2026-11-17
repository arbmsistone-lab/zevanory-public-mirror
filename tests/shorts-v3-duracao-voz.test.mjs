// NC-1052-01 (parte sem ferramentas externas, roda na suíte em todo SO): o render mede a duração da voz DEPOIS do
// processamento e a usa em todos os passos. A parte com ffmpeg/ffprobe reais (atempo alonga o áudio) está em
// tests/media/shorts-v2-media.test.mjs, no workflow de mídia que tem ffmpeg.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
test('v3: duração da voz vem do WAV processado, medida depois do atempo e antes de todos os usos',async()=>{
 const {duracaoAudio,filtroVozV3}=await import('../scripts/shorts-v3/render.mjs');
 assert.ok(filtroVozV3(0.9).includes('atempo=0.9'));
 const src=readTextNormalized('scripts/shorts-v3/render.mjs');
 assert.doesNotMatch(src,/pcm\.length\/2\/24000/,'nenhuma duração tirada do PCM bruto');
 const i=src.indexOf("normalizeTwoPass(base+'-voz-tratada.wav',base+'-voz.wav'"),j=src.indexOf("const voiceDuration=duracaoAudio(base+'-voz.wav')");
 assert.ok(i>0&&j>i,'duração medida depois do processamento');
 for(const uso of ['alignedWords(alignment,speech,voiceDuration','gruposCurtosV3(words,spec.falas','shortTiming(voiceDuration'])assert.ok(src.indexOf(uso)>j,uso);
 assert.equal(duracaoAudio('x',()=>JSON.stringify({format:{duration:'2.105'}})),2.105);
 assert.throws(()=>duracaoAudio('x',()=>JSON.stringify({format:{duration:'N/A'}})),/v3_duracao_voz_invalida/);
});
test('v3 (ensaio 43625938908): atempo MEDIDO por geração leva o ritmo ao alvo sem estourar a duração nem acelerar',async()=>{
 const {atempoVoz,filtroVozV3,PPM_ALVO,VOZ_DURACAO_MAX_S,ATEMPO_MIN}=await import('../scripts/shorts-v3/render.mjs');
 // voz bruta do ensaio real: 98 palavras em ~30,02 s (195,9 ppm) -> com 0,95 fixo deu 185,94 ppm (reprovado)
 const a=atempoVoz(98,30.02),ppm=98/(30.02/a)*60;
 assert.ok(Math.abs(ppm-PPM_ALVO)<0.05,`ppm final ${ppm}`);assert.ok(ppm<=185&&ppm>=140);assert.ok(30.02/a<=VOZ_DURACAO_MAX_S);
 assert.equal(atempoVoz(98,36),1,'voz já lenta: nunca acelera (atempo ≤ 1)');
 const b=atempoVoz(98,31.5);assert.ok(31.5/b<=VOZ_DURACAO_MAX_S+0.01,'limite de duração prevalece sobre o alvo');
 assert.equal(atempoVoz(98,20),ATEMPO_MIN,'nunca desacelera abaixo do mínimo');
 for(const x of [[0,30],[98,0],[NaN,30],[98,-1]])assert.throws(()=>atempoVoz(...x),/v3_atempo_entrada_invalida/);
 assert.throws(()=>filtroVozV3(0.5),/v3_atempo_fora_da_faixa/);assert.throws(()=>filtroVozV3(1.2),/v3_atempo_fora_da_faixa/);
 const src=readTextNormalized('scripts/shorts-v3/render.mjs');
 const i=src.indexOf("duracaoAudio(base+'-voz-bruta.wav')"),j=src.indexOf("filtroVozV3(atempo)"),k=src.indexOf("const voiceDuration=duracaoAudio(base+'-voz.wav')");
 assert.ok(i>0&&j>i&&k>j,'mede a voz bruta, aplica o atempo medido e só então mede a voz final');
});
