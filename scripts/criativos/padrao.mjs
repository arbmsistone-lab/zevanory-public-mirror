// Laboratório de Criativos — PADRÃO NOTA 10. Duas camadas:
// 1) BASE (fixa, no código): critérios que nenhuma pesquisa pode afrouxar — verdade comercial e financeira,
//    legibilidade, área segura, prova real do produto. Vêm da contra-auditoria GPT-6 de 13/11/2026.
// 2) OBSERVADO (pesquisa): só FATOS calculados por código a partir dos metadados reais dos Shorts que mais performam
//    (duração, títulos, engajamento), cada um com os vídeos que o sustentam (NC-01: nada de conclusão visual a
//    partir de metadados; nada escrito pela IA). A validação recalcula os fatos a partir da evidência.
import {padroesDeMetadados} from './pesquisa.mjs';
export const CRITERIOS=Object.freeze([
 {id:'gancho',peso:0.25,pergunta:'Nos primeiros 2 s há uma dor concreta e específica do público, em poucas palavras, que gera curiosidade para continuar?'},
 {id:'legibilidade',peso:0.15,pergunta:'Todo texto é legível no celular, com hierarquia clara, sem quadro vazio, dentro da área segura (sem conteúdo essencial nos 450 px de baixo e 140 px à direita)?'},
 {id:'prova',peso:0.25,pergunta:'O vídeo mostra o produto real funcionando (páginas/planilha reais, números calculados de verdade), não só promessa?'},
 {id:'oferta',peso:0.20,pergunta:'O final apresenta primeiro o benefício, depois nome do kit, preço oficial, garantia e chamada clara para a descrição?'},
 {id:'marca',peso:0.15,pergunta:'Visual consistente com a marca ZEVANORY (cores, tipografia, logo), profissional e sem aparência de modelo genérico?'}
]);
export const NOTA_MINIMA=9.5;
const obj=o=>o&&typeof o==='object'&&!Array.isArray(o);
export function montarPadrao({evidencia,geradoEm}){
 const ev=(evidencia||[]).map(({id,sku,titulo,canal,segundos,views,likes,comments,score,url,confirmado_short})=>({id,sku,titulo,canal,segundos,views,likes,comments,score,url,confirmado_short}));
 return {schema:2,geradoEm,nota_minima:NOTA_MINIMA,criterios:CRITERIOS,observado:ev.length?padroesDeMetadados(ev):[],evidencia:ev};
}
export function validarPadrao(p){
 if(!obj(p)||p.schema!==2||p.nota_minima!==NOTA_MINIMA||JSON.stringify(p.criterios)!==JSON.stringify(CRITERIOS)||!Array.isArray(p.observado)||!Array.isArray(p.evidencia))throw Error('padrao_invalido');
 if(p.evidencia.some(v=>v.confirmado_short!==true))throw Error('padrao_invalido_nao_short');
 const recalculado=p.evidencia.length?padroesDeMetadados(p.evidencia):[];
 if(JSON.stringify(recalculado)!==JSON.stringify(p.observado))throw Error('padrao_invalido_fatos_nao_conferem');
 return p;
}
