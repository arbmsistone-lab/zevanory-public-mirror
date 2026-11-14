// NC-1052-01 (parte sem ferramentas externas, roda na suíte em todo SO): o render mede a duração da voz DEPOIS do
// processamento e a usa em todos os passos. A parte com ffmpeg/ffprobe reais (atempo alonga o áudio) está em
// tests/media/shorts-v2-media.test.mjs, no workflow de mídia que tem ffmpeg.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
test('v3: duração da voz vem do WAV processado, medida depois do atempo e antes de todos os usos',async()=>{
 const {duracaoAudio,FILTRO_VOZ_V3,VOZ_ATEMPO}=await import('../scripts/shorts-v3/render.mjs');
 assert.ok(FILTRO_VOZ_V3.includes(`atempo=${VOZ_ATEMPO}`));
 const src=readTextNormalized('scripts/shorts-v3/render.mjs');
 assert.doesNotMatch(src,/pcm\.length\/2\/24000/,'nenhuma duração tirada do PCM bruto');
 const i=src.indexOf("normalizeTwoPass(base+'-voz-tratada.wav',base+'-voz.wav'"),j=src.indexOf("const voiceDuration=duracaoAudio(base+'-voz.wav')");
 assert.ok(i>0&&j>i,'duração medida depois do processamento');
 for(const uso of ['alignedWords(alignment,speech,voiceDuration','gruposCurtosV3(words,spec.falas','shortTiming(voiceDuration'])assert.ok(src.indexOf(uso)>j,uso);
 assert.equal(duracaoAudio('x',()=>JSON.stringify({format:{duration:'2.105'}})),2.105);
 assert.throws(()=>duracaoAudio('x',()=>JSON.stringify({format:{duration:'N/A'}})),/v3_duracao_voz_invalida/);
});
