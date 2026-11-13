// Calibração DETERMINÍSTICA com OCR real sobre os casos homologados (scripts/criativos/calibracao-casos.mjs — a MESMA
// lista que o workflow semanal roda com o júri real): o positivo passa sem nenhum motivo objetivo e cada negativo é
// reprovado pelos motivos esperados.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requireTool} from '../helpers/toolchain.mjs';
import {CASOS,prepararCaso,medirCaso,spec} from '../../scripts/criativos/calibracao-casos.mjs';
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
