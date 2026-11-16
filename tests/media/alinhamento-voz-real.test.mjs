// GPT-6 (15/11, ensaio 43785769084): a voz REAL desse ensaio reprovou no alinhamento antes do júri. Na frase 1 sobrou
// 0,68 s de som depois da última palavra (-18,8 dB contra -14,6 dB da fala, menos de 10 dB abaixo -> "voz", não cauda),
// o caminho por frase caiu e o alinhamento inteiro deixou 11 de 94 palavras instantâneas (máximo 9).
// Este teste roda ESSE áudio (fixture com SHA-256 conferido) pelo MESMO caminho do ensaio (ensaio-fases.mjs render ->
// renderV3 -> align.py com stable-ts 2.19.1, modelos base/small), sem gerar voz nem chamar o Gemini. Só a oferta
// publicada é simulada (preço oficial). Limites intactos: 10% de instantâneas e cauda >= 10 dB abaixo da fala.
// Roda no job "alinhamento-real" (.github/workflows/shorts-v2-checks.yml), que instala o alinhador.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {renderV3} from '../../scripts/shorts-v3/render.mjs';
import {render as renderEnsaio} from '../../scripts/shorts-v3/ensaio-fases.mjs';
const FIX='tests/fixtures/voz-ensaio-43785769084',sha=b=>createHash('sha256').update(b).digest('hex');
test('voz real do ensaio 43785769084: alinha pelo caminho do ensaio, dentro dos limites atuais',{timeout:1500000},async()=>{
 const O=JSON.parse(readFileSync(join(FIX,'ORIGEM.json'),'utf8'));
 assert.equal(sha(readFileSync(join(FIX,'voz.pcm'))),O.voz_pcm_sha256,'fixture íntegra');
 assert.equal(sha(readFileSync(join(FIX,'meta.json'))),O.meta_json_sha256);
 const dir=mkdtempSync(join(tmpdir(),'alinh-real-')),notas=[];
 try{
  const comOferta=(specPath,base,o)=>renderV3(specPath,base,{...o,oferta:async()=>({fonte:'https://vendas.zevanory.api.br/lucro-e-caixa',preco:147,versao:'sha256:simulada',lido_em:'2026-11-15T12:00:00Z'})});
  let erro=null;
  try{await renderEnsaio(join(dir,'out'),FIX,'oferta',{renderImpl:comOferta,note:m=>{notas.push(String(m));console.log(String(m).slice(0,300));}});}catch(e){erro=e;}
  const log=notas.filter(n=>/^ALIGN_/.test(n));
  console.log('ALINHAMENTO_REAL '+JSON.stringify(log));
  assert.equal(erro,null,'render reprovou: '+String(erro?.message||'').slice(0,240)+' | '+log.join(' || ').slice(0,600));
  assert.ok(notas.some(n=>/^ALIGN_FRASES ok /.test(n)),'alinhamento por frase aceito');
  const o=JSON.parse(readFileSync(join(dir,'out','juri','objetivas-candidato.json'),'utf8'));
  assert.equal(o.aprovado_objetivo,true,JSON.stringify([o.motivos_objetivos,o.motivos_audio]));
  assert.ok(existsSync(join(dir,'out','short-preview.mp4')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
