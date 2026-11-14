// CLI: calibração REAL do avaliador sobre TODOS os casos homologados (scripts/criativos/calibracao-casos.mjs): OCR
// real, oferta lida da página de vendas no ar e júri Gemini. Falha (NC-R02/R04) se:
//  - o positivo homologado não for APROVADO (objetivas OK e TODAS as notas >= 9,5) — reprovação injustificada;
//  - algum negativo for APROVADO ou não trouxer os motivos esperados — aprovação indevida / motivo errado.
// Uso: node scripts/criativos/rodar-calibracao.mjs <padrao-10.json|-> <pasta-saida>
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {avaliar,permitidosDaProveniencia,precosOficiais} from './avaliador.mjs';
import {ofertaPublicada} from './afirmacoes.mjs';
import {montarPadrao,validarPadrao} from './padrao.mjs';
import {CASOS,prepararCaso,medirCaso,quadrosJuri,spec} from './calibracao-casos.mjs';
import {conferirManifesto} from '../shorts-v3/render.mjs';
const [padArg,out]=process.argv.slice(2);if(!out)throw Error('uso: rodar-calibracao.mjs <padrao|-> <saida>');mkdirSync(out,{recursive:true});
const padrao=validarPadrao(padArg&&padArg!=='-'?JSON.parse(readFileSync(padArg,'utf8')):montarPadrao({evidencia:[],geradoEm:'base'}));
const S=spec(),oficial=await ofertaPublicada(S.slug),permitidos=permitidosDaProveniencia(await conferirManifesto(S),precosOficiais()[S.sku][1]);
console.log(`OFERTA_PUBLICADA ${oficial.fonte} preco=${oficial.preco} versao=${oficial.versao}`);
const falhas=[],resultados=[];
for(const caso of CASOS){
 const dir=join(out,caso.nome),prep=prepararCaso(caso,dir),medicao=medirCaso(prep,dir);
 const r=await avaliar({criativo:prep.criativo,padrao,quadrosPng:quadrosJuri(prep,dir),medicao,permitidos,oficial,key:process.env.GEMINI_API_KEY});
 writeFileSync(join(dir,'avaliacao.json'),JSON.stringify({medicao:medicao.medidas,...r},null,2));
 console.log(`CALIBRACAO ${caso.nome} decisao=${r.decisao} nota_geral=${r.nota_geral??'n/d'} notas=${r.juri?JSON.stringify(r.juri.notas):'n/d'} modelo=${r.modelo||'-'} motivos=${r.motivos.join(',')||'-'}${r.erro?' erro='+r.erro:''}`);
 for(const p of r.juri?.problemas||[])console.log(`  PROBLEMA ${caso.nome}: ${p}`);
 if(caso.tipo==='positivo'){if(!r.aprovado)falhas.push('positivo_nao_aprovado:'+(r.motivos.join('+')||r.erro||'?'));}
 else{if(r.aprovado)falhas.push('aprovacao_indevida:'+caso.nome);const faltando=caso.esperado.filter(e=>!r.motivos.includes(e));if(faltando.length)falhas.push(`motivo_ausente:${caso.nome}:${faltando.join('+')}`);}
 resultados.push({caso:caso.nome,decisao:r.decisao,nota_geral:r.nota_geral,notas:r.juri?.notas||null,motivos:r.motivos});
}
writeFileSync(join(out,'calibracao.json'),JSON.stringify({em:new Date().toISOString(),oficial,padrao:padrao.geradoEm,casos:resultados,falhas},null,2));
if(falhas.length){console.log('::error title=CALIBRACAO::'+falhas.join(' | '));process.exitCode=1;}
else console.log(`CALIBRACAO_OK ${CASOS.length} casos: positivo APROVADO; ${CASOS.length-1} negativos DESCARTADOS pelos motivos esperados`);
