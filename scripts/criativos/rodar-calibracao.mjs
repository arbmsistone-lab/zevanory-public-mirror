// CLI: calibração REAL do avaliador (OCR + oferta publicada no ar + júri Gemini) com referência positiva e negativos.
// Falha se: algum negativo for APROVADO (aprovação indevida); a referência positiva tiver qualquer motivo objetivo
// (reprovação injustificada) ou o júri estiver quebrado (sem notas ou nota geral < 8). Registra tudo em <saida>.
// Uso: node scripts/criativos/rodar-calibracao.mjs <padrao-10.json|-> <pasta-saida>
import {readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {avaliar,permitidosDe,precosOficiais} from './avaliador.mjs';
import {ofertaPublicada} from './afirmacoes.mjs';
import {montarPadrao,validarPadrao} from './padrao.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const [padArg,out]=process.argv.slice(2);if(!out)throw Error('uso: rodar-calibracao.mjs <padrao|-> <saida>');mkdirSync(out,{recursive:true});
const padrao=validarPadrao(padArg&&padArg!=='-'?JSON.parse(readFileSync(padArg,'utf8')):montarPadrao({evidencia:[],geradoEm:'base'}));
const SPEC=JSON.parse(readFileSync(join(ROOT,'data/shorts-v3/lcx.json'),'utf8'));
const py=a=>{const r=spawnSync('python3',['-I',...a],{encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw Error('calibracao_python:'+r.stderr.slice(-200));return r.stdout;};
const oficial=await ofertaPublicada(SPEC.slug);
console.log(`OFERTA_PUBLICADA ${oficial.fonte} preco=${oficial.preco} versao=${oficial.versao}`);
async function caso(nome,spec,{remover=null,quadrosProntos=null}={}){
 const dir=join(out,nome);mkdirSync(dir,{recursive:true});
 let fs=quadrosProntos;
 if(!fs){writeFileSync(join(dir,'spec.json'),JSON.stringify(spec));const q=JSON.parse(py([join(ROOT,'scripts/shorts-v3/quadros.py'),ROOT,join(dir,'spec.json'),join(dir,'q')])).quadros;if(remover)delete q[remover];fs=Object.values(q).sort();}
 writeFileSync(join(dir,'medir.json'),JSON.stringify({quadros:fs,provas:SPEC.provas.map(p=>({captura:join(ROOT,p.captura),largura:p.largura}))}));
 const medicao=JSON.parse(py([join(ROOT,'scripts/criativos/medir.py'),join(dir,'medir.json')]));
 const jur=fs.map((f,i)=>{const p=join(dir,`juri-${i}.png`);py(['-c',"import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').resize((540,960)).save(sys.argv[2])",f,p]);return readFileSync(p);});
 const r=await avaliar({criativo:{sku:spec.sku,falas:spec.falas.map(f=>f.texto),oferta:{nome:spec.oferta.nome,preco:spec.oferta.preco}},padrao,quadrosPng:jur,medicao,permitidos:permitidosDe(SPEC.numeros,precosOficiais()[SPEC.sku][1]),oficial,key:process.env.GEMINI_API_KEY});
 writeFileSync(join(dir,'avaliacao.json'),JSON.stringify({medicao:medicao.medidas,...r},null,2));
 console.log(`CALIBRACAO ${nome} decisao=${r.decisao} nota_geral=${r.nota_geral??'n/d'} notas=${r.juri?JSON.stringify(r.juri.notas):'n/d'} modelo=${r.modelo||'-'} motivos=${r.motivos.join(',')||'-'}${r.erro?' erro='+r.erro:''}`);
 return r;
}
const falhas=[];
const pos=await caso('positivo-v3-lcx',SPEC);
const objetivasPos=pos.motivos.filter(m=>!m.startsWith('nota_abaixo:'));
if(objetivasPos.length)falhas.push('positivo_reprovado_nas_objetivas:'+objetivasPos.join('+'));
if(!pos.juri||!(pos.nota_geral>=8))falhas.push('juri_quebrado_ou_incoerente_no_positivo');
const clone=()=>JSON.parse(JSON.stringify(SPEC));
const negativos=[['negativo-preco-97',(()=>{const s=clone();s.oferta.preco=97;return s;})()],['negativo-promessa',(()=>{const s=clone();s.oferta.beneficio='Lucro garantido em cada venda.';return s;})()],['negativo-sem-planilha',clone(),{remover:'planilha'}]];
for(const [n,s,o] of negativos){const r=await caso(n,s,o||{});if(r.aprovado)falhas.push('aprovacao_indevida:'+n);}
const v2d=join(ROOT,'docs/criativos/calibracao/v2-reprovado'),v2=JSON.parse(readFileSync(join(v2d,'criativo.json'),'utf8'));
mkdirSync(join(out,'v2'),{recursive:true});
const v2f=readdirSync(v2d).filter(f=>f.endsWith('.png')).sort().map(f=>{const t=join(out,'v2',f);copyFileSync(join(v2d,f),t);return t;});
const r2=await caso('negativo-v2-reprovado',{...SPEC,sku:v2.sku,falas:v2.textos.map(texto=>({texto})),oferta:{nome:'',preco:0}},{quadrosProntos:v2f});if(r2.aprovado)falhas.push('aprovacao_indevida:v2');
writeFileSync(join(out,'calibracao.json'),JSON.stringify({em:new Date().toISOString(),oficial,falhas},null,2));
if(falhas.length){console.log('::error title=CALIBRACAO::'+falhas.join(' | '));process.exitCode=1;}else console.log('CALIBRACAO_OK positivo sem motivo objetivo; todos os negativos descartados');
