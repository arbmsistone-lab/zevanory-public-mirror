// CLI: avalia um criativo contra o padrão nota 10 e decide APROVADO/DESCARTADO.
// Uso: node scripts/criativos/rodar-avaliacao.mjs <padrao-10.json> <criativo.json> <saida.json> <quadro1.png> [quadro2.png ...]
import {readFileSync,writeFileSync} from 'node:fs';
import {avaliar} from './avaliador.mjs';
import {validarPadrao} from './padrao.mjs';
const [pad,cri,saida,...quadros]=process.argv.slice(2);
if(!pad||!cri||!saida||!quadros.length)throw Error('uso: rodar-avaliacao.mjs <padrao> <criativo> <saida> <quadros...>');
const padrao=validarPadrao(JSON.parse(readFileSync(pad,'utf8'))),criativo=JSON.parse(readFileSync(cri,'utf8'));
const r=await avaliar({criativo,padrao,quadrosPng:quadros.map(q=>readFileSync(q)),key:process.env.GEMINI_API_KEY});
writeFileSync(saida,JSON.stringify(r,null,2));
console.log(`CRIATIVO ${criativo.nome||criativo.sku} decisao=${r.decisao} nota_geral=${r.nota_geral??'n/d'} notas=${r.juri?JSON.stringify(r.juri.notas):'n/d'} motivos=${r.motivos.join(',')||'-'}${r.erro?' erro='+r.erro:''}`);
for(const p of r.juri?.problemas||[])console.log('PROBLEMA '+p);
for(const p of r.juri?.melhorias||[])console.log('MELHORIA '+p);
