// CLI: pesquisa os Shorts que mais performam por tema, sintetiza o padrão nota 10 com IA e grava <saida>/padrao-10.json.
// Uso: node scripts/criativos/rodar-pesquisa.mjs <pasta-saida>
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {TEMAS,youtubeToken,pesquisarTema} from './pesquisa.mjs';
import {promptSintese,validarObservado,montarPadrao,validarPadrao} from './padrao.mjs';
import {gerarJSON} from './avaliador.mjs';
const out=process.argv[2];if(!out)throw Error('uso: rodar-pesquisa.mjs <pasta>');mkdirSync(out,{recursive:true});
const token=await youtubeToken({clientId:process.env.YOUTUBE_CLIENT_ID,clientSecret:process.env.YOUTUBE_CLIENT_SECRET,refreshToken:process.env.YOUTUBE_REFRESH_TOKEN});
const evidencia=[];
for(const [sku,consultas] of Object.entries(TEMAS)){const rows=await pesquisarTema({sku,consultas,token});evidencia.push(...rows);console.log(`PESQUISA ${sku} videos=${rows.length} top_views=${rows[0]?.views||0}`);}
const vistos=new Set(),unicos=evidencia.filter(v=>!vistos.has(v.id)&&vistos.add(v.id));
const {modelo,saida}=await gerarJSON({key:process.env.GEMINI_API_KEY,partes:[{text:promptSintese(unicos)}]});
const observado=validarObservado(saida,unicos);
const padrao=validarPadrao(montarPadrao({evidencia:unicos,observado,geradoEm:new Date().toISOString()}));
writeFileSync(join(out,'padrao-10.json'),JSON.stringify(padrao,null,2));
console.log(`PADRAO_10 modelo=${modelo} evidencias=${unicos.length} padroes=${observado.length}`);
for(const o of observado)console.log(`PADRAO (${o.criterio}) ${o.padrao} [${o.evidencias.length} videos]`);
