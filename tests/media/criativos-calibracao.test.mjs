// Calibração DETERMINÍSTICA do Laboratório de Criativos com OCR real (tesseract) sobre quadros renderizados:
// 1 referência positiva (v3 Lucro & Caixa) que precisa passar sem nenhum motivo (sem reprovação injustificada) e
// casos negativos independentes que precisam reprovar PELO MOTIVO CERTO (sem aprovação indevida).
// O júri de IA é calibrado no workflow criativos-laboratorio (credenciais reais), não aqui.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireTool} from '../helpers/toolchain.mjs';
import {readTextNormalized} from '../helpers/text.mjs';
import {checagensObjetivas,permitidosDe} from '../../scripts/criativos/avaliador.mjs';
requireTool('python3');requireTool('tesseract');
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const SPEC=JSON.parse(readTextNormalized(new URL('../../data/shorts-v3/lcx.json',import.meta.url)));
const PROVAS=SPEC.provas.map(p=>({captura:join(ROOT,p.captura),largura:p.largura}));
const OFICIAL={fonte:'https://vendas.zevanory.api.br/lucro-e-caixa',preco:147,versao:'sha256:calibracao'};
const PERM=permitidosDe(SPEC.numeros,147);
const py=(args,input)=>{const r=spawnSync('python3',['-I',...args],{encoding:'utf8',input,maxBuffer:64*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
function quadros(spec,dir){const p=join(dir,'spec.json');writeFileSync(p,JSON.stringify(spec));return JSON.parse(py([join(ROOT,'scripts/shorts-v3/quadros.py'),ROOT,p,join(dir,'q')])).quadros;}
function medir(frames,dir,provas=PROVAS){const p=join(dir,'medir.json');writeFileSync(p,JSON.stringify({quadros:frames,provas}));return JSON.parse(py([join(ROOT,'scripts/criativos/medir.py'),p]));}
const criativo=(spec=SPEC)=>({sku:spec.sku,falas:spec.falas.map(f=>f.texto),oferta:{nome:spec.oferta.nome,preco:spec.oferta.preco}});
const caso=(fn)=>{const dir=mkdtempSync(join(tmpdir(),'zev-cal-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}};
const ordem=fs=>Object.values(fs).sort();
test('CAL+ v3 Lucro & Caixa: passa nas objetivas sem nenhum motivo (OCR real, prova por correlação)',()=>caso(dir=>{
  const m=medir(ordem(quadros(SPEC,dir)),dir);
  assert.equal(m.medidas.origem,'medicao_independente_ocr');assert.equal(m.medidas.provaReal,true);
  assert.deepEqual(checagensObjetivas({criativo:criativo(),medicao:m,permitidos:PERM,oficial:OFICIAL}),[]);
}));
const neg=(nome,mutar,esperado)=>test('CAL- '+nome,()=>caso(dir=>{const spec=structuredClone(SPEC);const r=mutar(spec,dir);const motivos=checagensObjetivas({criativo:criativo(r.spec||spec),medicao:r.medicao,permitidos:PERM,oficial:OFICIAL});
  for(const e of esperado)assert.ok(motivos.includes(e),`${nome}: esperado ${e}; obtido ${motivos.join(',')}`);}));
neg('preço errado na tela (R$ 97)',(s,dir)=>{s.oferta.preco=97;return {spec:s,medicao:medir(ordem(quadros(s,dir)),dir)};},['preco_divergente','preco_oficial_ausente_no_video','valor_nao_conferido:R$97']);
neg('promessa de lucro garantido',(s,dir)=>{s.oferta.beneficio='Lucro garantido em cada venda.';return {spec:s,medicao:medir(ordem(quadros(s,dir)),dir)};},['promessa_proibida','lucro_fora_do_nome_do_produto']);
neg('número que a planilha não calculou (R$ 48)',(s,dir)=>{s.numeros.margem_antes_fixas=48;return {spec:s,medicao:medir(ordem(quadros(s,dir)),dir)};},['valor_nao_conferido:R$48']);
neg('sem a captura real da planilha',(s,dir)=>{const fs=quadros(s,dir);delete fs.planilha;return {medicao:medir(ordem(fs),dir)};},['sem_prova_real_do_produto']);
neg('quadro vazio',(s,dir)=>{const fs=quadros(s,dir);py(['-c',"import sys;from PIL import Image;Image.new('RGB',(1080,1920),(9,13,20)).save(sys.argv[1])",fs.venda]);return {medicao:medir(ordem(fs),dir)};},['quadro_vazio']);
neg('texto fora da área segura',(s,dir)=>{const fs=quadros(s,dir);py(['-c',"import sys;from PIL import Image,ImageDraw,ImageFont;im=Image.open(sys.argv[1]);ImageDraw.Draw(im).text((120,1640),'Oferta especial hoje',font=ImageFont.truetype(sys.argv[2],70),fill=(255,255,255));im.save(sys.argv[1])",fs.oferta,join(ROOT,'assets/fonts/Inter-ExtraBold.ttf')]);return {medicao:medir(ordem(fs),dir)};},['conteudo_fora_da_area_segura']);
neg('texto miúdo',(s,dir)=>{const fs=quadros(s,dir);py(['-c',"import sys;from PIL import Image,ImageDraw,ImageFont;im=Image.open(sys.argv[1]);ImageDraw.Draw(im).text((120,1150),'condições e detalhes importantes',font=ImageFont.truetype(sys.argv[2],18),fill=(255,255,255));im.save(sys.argv[1])",fs.gancho,join(ROOT,'assets/fonts/Inter-ExtraBold.ttf')]);return {medicao:medir(ordem(fs),dir)};},['texto_pequeno_demais']);
neg('v2 reprovado por humano e GPT-6',(s,dir)=>{const d=join(ROOT,'docs/criativos/calibracao/v2-reprovado'),c=JSON.parse(readTextNormalized(join(d,'criativo.json')));
  const fs=readdirSync(d).filter(f=>f.endsWith('.png')).sort().map(f=>{const t=join(dir,f);copyFileSync(join(d,f),t);return t;});
  return {spec:{...s,sku:c.sku,falas:c.textos.map(texto=>({texto})),oferta:{nome:'',preco:0}},medicao:medir(fs,dir)};},['sem_prova_real_do_produto','preco_oficial_ausente_no_video','concordancia_genero','texto_artificial_ficticio']);
