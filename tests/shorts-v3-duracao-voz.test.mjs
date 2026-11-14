// NC-1052-01: a duração usada no v3 é a do WAV processado (atempo 0,95 alonga ~5,26%), nunca a do PCM bruto.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readTextNormalized} from './helpers/text.mjs';import {requireTool} from './helpers/toolchain.mjs';
test('v3: atempo muda a duração real da voz e o render usa a duração medida do WAV processado',async()=>{
 requireTool('ffmpeg',['-version']);requireTool('ffprobe',['-version']);
 const {FILTRO_VOZ_V3,VOZ_ATEMPO,duracaoAudio}=await import('../scripts/shorts-v3/render.mjs');
 const d=mkdtempSync(join(tmpdir(),'zev-dur-'));try{
  const pcm=Buffer.alloc(24000*2*2);for(let i=0;i<48000;i++)pcm.writeInt16LE(Math.round(8000*Math.sin(i/24000*2*Math.PI*220)),i*2);// 2,000 s
  writeFileSync(join(d,'v.pcm'),pcm);const bruto=pcm.length/2/24000;
  const r=spawnSync('ffmpeg',['-v','error','-y','-f','s16le','-ar','24000','-ac','1','-i',join(d,'v.pcm'),'-af',FILTRO_VOZ_V3,'-c:a','pcm_s16le',join(d,'v.wav')],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const real=duracaoAudio(join(d,'v.wav'));
  assert.ok(Math.abs(real-bruto/VOZ_ATEMPO)<0.03,`duração processada ${real} ≈ ${bruto/VOZ_ATEMPO}`);
  assert.ok(real-bruto>0.08,'o filtro realmente alonga o áudio (o PCM bruto não serve como duração)');
 }finally{rmSync(d,{recursive:true,force:true});}
 const src=readTextNormalized('scripts/shorts-v3/render.mjs');
 assert.doesNotMatch(src,/pcm\.length\/2\/24000/,'nenhuma duração tirada do PCM bruto');
 const i=src.indexOf("normalizeTwoPass(base+'-voz-tratada.wav',base+'-voz.wav'"),j=src.indexOf("const voiceDuration=duracaoAudio(base+'-voz.wav')");
 assert.ok(i>0&&j>i,'duração medida depois do processamento');
 for(const uso of ['alignedWords(alignment,speech,voiceDuration','gruposCurtosV3(words,spec.falas','shortTiming(voiceDuration'])assert.ok(src.indexOf(uso)>j,uso);
 assert.throws(()=>duracaoAudio('x',()=>JSON.stringify({format:{duration:'N/A'}})),/v3_duracao_voz_invalida/);
});
