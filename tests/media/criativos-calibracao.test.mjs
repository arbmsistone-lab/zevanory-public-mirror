// Calibração DETERMINÍSTICA com OCR real sobre os casos homologados (scripts/criativos/calibracao-casos.mjs — a MESMA
// lista que o workflow semanal roda com o júri real): o positivo passa sem nenhum motivo objetivo e cada negativo é
// reprovado pelos motivos esperados.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requireTool} from '../helpers/toolchain.mjs';
import {CASOS,prepararCaso,medirCaso,spec,ROOT} from '../../scripts/criativos/calibracao-casos.mjs';
import {checagensObjetivas,permitidosDaProveniencia} from '../../scripts/criativos/avaliador.mjs';
import {conferirManifesto} from '../../scripts/shorts-v3/render.mjs';
requireTool('python3');requireTool('tesseract');
const OFICIAL={fonte:'https://vendas.zevanory.api.br/lucro-e-caixa',preco:147,versao:'sha256:calibracao'};
const PERM=permitidosDaProveniencia(await conferirManifesto(spec()),147);
for(const caso of CASOS)test('CAL '+caso.nome,()=>{const dir=mkdtempSync(join(tmpdir(),'zev-cal-'));try{
  const prep=prepararCaso(caso,dir),medicao=medirCaso(prep,dir),motivos=checagensObjetivas({criativo:prep.criativo,medicao,permitidos:PERM,oficial:OFICIAL});
  if(caso.tipo==='positivo')assert.deepEqual(motivos,[],'positivo homologado sem reprovação injustificada');
  else for(const e of caso.esperado)assert.ok(motivos.includes(e),`${caso.nome}: esperado ${e}; obtido ${motivos.join(',')}`);
 }finally{rmSync(dir,{recursive:true,force:true});}});
// NC-R01 (adversarial): um erro exibido SÓ entre duas amostras (0,4 s, entre duas cenas) escapa da amostragem antiga
// de 1 quadro por fala, mas é pego pela medição do MP4 inteiro (todos os estados visuais).
test('CAL R01 erro só entre duas amostras: amostragem por fala não vê; MP4 inteiro reprova',()=>{requireTool('ffmpeg',['-version']);const dir=mkdtempSync(join(tmpdir(),'zev-r01-'));try{
  const prep=prepararCaso(CASOS.find(c=>c.tipo==='positivo'),dir),q=prep.quadros,flash=join(dir,'flash.png');
  const py=(...a)=>{const r=spawnSync('python3',['-E','-P',...a],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  py('-c',"import sys;from PIL import Image,ImageDraw,ImageFont;im=Image.open(sys.argv[1]).convert('RGB');ImageDraw.Draw(im).text((120,1250),'Lucro garantido: R$ 97',font=ImageFont.truetype(sys.argv[3],64),fill=(255,255,255));im.save(sys.argv[2])",q[2],flash,join(ROOT,'assets/fonts/Inter-ExtraBold.ttf'));
  const seq=[...q.slice(0,2).map(f=>[f,1]),[flash,0.4],...q.slice(2).map(f=>[f,1])];
  writeFileSync(join(dir,'lista.txt'),seq.map(([f,d])=>`file '${f}'\nduration ${d}`).join('\n')+`\nfile '${q.at(-1)}'\n`);
  const mp4=join(dir,'v.mp4'),ff=spawnSync('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',join(dir,'lista.txt'),'-vf','fps=30,format=yuv420p','-c:v','libx264','-preset','veryfast',mp4],{encoding:'utf8'});assert.equal(ff.status,0,ff.stderr);
  const checar=medicao=>checagensObjetivas({criativo:prep.criativo,medicao,permitidos:PERM,oficial:OFICIAL});
  // amostragem antiga: o meio de cada cena de 1 s (o flash de 0,4 s fica entre duas amostras)
  const amostras=[];let t=0;for(const [f,d] of seq){if(f!==flash){const p=join(dir,`amostra-${amostras.length}.png`);const r=spawnSync('ffmpeg',['-v','error','-y','-ss',String(t+d/2),'-i',mp4,'-frames:v','1',p]);assert.equal(r.status,0);amostras.push(p);}t+=d;}
  const porFala=checar(medirCaso({...prep,quadros:amostras},dir));
  assert.ok(!porFala.some(m=>/R\$97|lucro/.test(m)),'premissa: a amostragem por fala não enxerga o flash ('+porFala.join(',')+')');
  writeFileSync(join(dir,'medir-video.json'),JSON.stringify({video:mp4,pasta_estados:join(dir,'estados'),provas:prep.provas.map(p=>({captura:join(ROOT,p.captura),largura:p.largura}))}));
  const r=spawnSync('python3',['-E','-P',join(ROOT,'scripts/criativos/medir.py'),join(dir,'medir-video.json')],{encoding:'utf8',maxBuffer:64*1024*1024});assert.equal(r.status,0,r.stderr);
  const inteiro=checar(JSON.parse(r.stdout));
  assert.ok(inteiro.includes('valor_nao_conferido:R$97'),'MP4 inteiro pega o valor falso do flash: '+inteiro.join(','));
  assert.ok(inteiro.some(m=>/lucro|promessa|politica/.test(m)),'e a promessa de lucro: '+inteiro.join(','));
 }finally{rmSync(dir,{recursive:true,force:true});}});
