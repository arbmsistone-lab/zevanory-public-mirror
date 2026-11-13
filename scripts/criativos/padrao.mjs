// Laboratório de Criativos — PADRÃO NOTA 10. Duas camadas:
// 1) BASE (fixa, no código): critérios que nenhuma pesquisa pode afrouxar — verdade comercial, termos financeiros,
//    legibilidade, área segura, gramática, prova real do produto. Vêm da contra-auditoria GPT-6 de 13/11/2026.
// 2) OBSERVADO (pesquisa): padrões extraídos dos Shorts que mais performam, cada um com evidência (ids de vídeos e
//    números). A IA só pode ACRESCENTAR padrões com evidência; nunca remover ou reduzir a base.
export const CRITERIOS=Object.freeze([
 {id:'gancho',peso:0.25,pergunta:'Nos primeiros 2 s há uma dor concreta e específica do público, em poucas palavras, que gera curiosidade para continuar?'},
 {id:'legibilidade',peso:0.15,pergunta:'Todo texto é legível no celular, com hierarquia clara, sem quadro vazio, dentro da área segura (sem conteúdo essencial nos 450 px de baixo e 140 px à direita)?'},
 {id:'prova',peso:0.25,pergunta:'O vídeo mostra o produto real funcionando (páginas/planilha reais, números calculados de verdade), não só promessa?'},
 {id:'oferta',peso:0.20,pergunta:'O final apresenta primeiro o benefício, depois nome do kit, preço oficial, garantia e chamada clara para a descrição?'},
 {id:'marca',peso:0.15,pergunta:'Visual consistente com a marca ZEVANORY (cores, tipografia, logo), profissional e sem aparência de modelo genérico?'}
]);
export const NOTA_MINIMA=9.5;
export const PROIBIDO=Object.freeze([
 {re:/\blucro\s+(?:l[ií]quido\s+)?de\s+R\$/i,motivo:'lucro_sem_todos_os_custos'},
 {re:/\b(garantido|garantimos lucro|fique rico|renda extra garantida|resultado garantido)\b/i,motivo:'promessa_proibida'},
 {re:/\b(um|uns)\s+(reserva|peça|venda|entrega|agenda|proposta)\b/i,motivo:'concordancia_genero'},
 {re:/\bfict[ií]ci[oa]s?\b/i,motivo:'texto_artificial_ficticio'}
]);
const obj=o=>o&&typeof o==='object'&&!Array.isArray(o);
// Validação da síntese da IA: cada padrão observado precisa citar >=3 vídeos da evidência; números conferidos.
export function validarObservado(saida,evidencia){
 if(!obj(saida)||!Array.isArray(saida.padroes))throw Error('padrao_ia_formato');
 const ids=new Set(evidencia.map(v=>v.id)),ok=[];
 for(const p of saida.padroes.slice(0,20)){
  if(!obj(p)||typeof p.padrao!=='string'||p.padrao.length<8||p.padrao.length>240||!Array.isArray(p.evidencias))continue;
  const cit=[...new Set(p.evidencias.filter(id=>ids.has(id)))];if(cit.length<3)continue;
  if(!['gancho','legibilidade','prova','oferta','marca','ritmo'].includes(p.criterio))continue;
  ok.push({criterio:p.criterio,padrao:p.padrao.trim(),evidencias:cit.slice(0,8)});
 }
 if(ok.length<3)throw Error('padrao_ia_sem_evidencia_suficiente');
 return ok;
}
export function promptSintese(evidencia){
 const linhas=evidencia.map(v=>`${v.id} | ${v.segundos}s | ${v.views} views | ${v.likes} likes | ${v.comments} coment. | "${v.titulo.replace(/"/g,"'")}"`).join('\n');
 return `Você é diretor de criação de Shorts de conversão no Brasil. Abaixo estão os Shorts que mais performam (dados reais do YouTube) nos temas de um negócio de kits digitais para pequenos empresários. Extraia de 5 a 12 PADRÕES CONCRETOS e verificáveis que explicam o desempenho (gancho, ritmo, oferta, prova, legibilidade, marca). Cada padrão deve citar pelo menos 3 ids da lista em "evidencias". Não invente números nem vídeos. Responda só JSON: {"padroes":[{"criterio":"gancho|legibilidade|prova|oferta|marca|ritmo","padrao":"...","evidencias":["id1","id2","id3"]}]}\n\n${linhas}`;
}
export function montarPadrao({evidencia,observado,geradoEm}){
 return {schema:1,geradoEm,nota_minima:NOTA_MINIMA,criterios:CRITERIOS,observado,evidencia:evidencia.map(({id,sku,titulo,canal,segundos,views,likes,comments,score,url})=>({id,sku,titulo,canal,segundos,views,likes,comments,score,url}))};
}
export function validarPadrao(p){
 if(!obj(p)||p.schema!==1||p.nota_minima!==NOTA_MINIMA||JSON.stringify(p.criterios)!==JSON.stringify(CRITERIOS)||!Array.isArray(p.observado)||!Array.isArray(p.evidencia))throw Error('padrao_invalido');
 const ids=new Set(p.evidencia.map(v=>v.id));for(const o of p.observado)if(!Array.isArray(o.evidencias)||o.evidencias.filter(id=>ids.has(id)).length<3)throw Error('padrao_invalido_evidencia');
 return p;
}
