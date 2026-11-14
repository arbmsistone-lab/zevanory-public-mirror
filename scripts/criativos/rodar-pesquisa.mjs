// CLI: pesquisa os Shorts que mais performam por tema (confirmados como Shorts), calcula os fatos e grava <saida>/padrao-10.json.
// Uso: node scripts/criativos/rodar-pesquisa.mjs <pasta-saida>
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {TEMAS,youtubeToken,pesquisarTema} from './pesquisa.mjs';
import {montarPadrao,validarPadrao} from './padrao.mjs';
const out=process.argv[2];if(!out)throw Error('uso: rodar-pesquisa.mjs <pasta>');mkdirSync(out,{recursive:true});
const token=await youtubeToken({clientId:process.env.YOUTUBE_CLIENT_ID,clientSecret:process.env.YOUTUBE_CLIENT_SECRET,refreshToken:process.env.YOUTUBE_REFRESH_TOKEN});
const evidencia=[];
for(const [sku,consultas] of Object.entries(TEMAS)){const rows=await pesquisarTema({sku,consultas,token});evidencia.push(...rows);console.log(`PESQUISA ${sku} videos=${rows.length} top_views=${rows[0]?.views||0}`);}
const vistos=new Set(),unicos=evidencia.filter(v=>!vistos.has(v.id)&&vistos.add(v.id));
const padrao=validarPadrao(montarPadrao({evidencia:unicos,geradoEm:new Date().toISOString()}));
writeFileSync(join(out,'padrao-10.json'),JSON.stringify(padrao,null,2));
console.log(`PADRAO_10 evidencias=${unicos.length} (todas confirmadas como Shorts) fatos=${padrao.observado.length} chamadas_api=${unicos.length?'search:'+Object.values(TEMAS).flat().length+' videos:'+Object.keys(TEMAS).length:'0'}`);
for(const o of padrao.observado)console.log(`FATO ${o.fato} ${o.padrao} [${o.evidencias.length} videos]`);
