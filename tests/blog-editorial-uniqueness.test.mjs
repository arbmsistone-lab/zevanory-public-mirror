import test from "node:test";
import assert from "node:assert/strict";
import {longFormDailyArticle} from "../worker/multichannel-autonomy.mjs";
function trigrams(s){const words=String(s).toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu)||[];return new Set(words.slice(0,-2).map((_,i)=>words.slice(i,i+3).join(" ")));}
function jaccard(a,b){const aa=trigrams(a),bb=trigrams(b);const intersection=[...aa].filter(x=>bb.has(x)).length;return intersection/(aa.size+bb.size-intersection);}
const topics=[
 ["ia-pratica-pequenos-negocios","IA prática para pequenos negócios"],
 ["automacao-atendimento-clareza","Automação de atendimento com clareza"],
 ["conteudo-organico-com-evidencia","Conteúdo orgânico com evidência"],
 ["vendas-lojas-fortaleza","Vendas para lojas de Fortaleza"],
 ["caixa-comercio-juazeiro-do-norte","Caixa para comércios de Juazeiro do Norte"],
 ["atendimento-servicos-varzea-alegre","Atendimento em serviços de Várzea Alegre"]
];
test("all six daily editorial topics satisfy length and distinctness",()=>{
 const articles=topics.map(([slug,title])=>longFormDailyArticle({slug,title,description:title},"2026-10-10"));
 for(const item of articles){
  assert.ok(item.word_count>=600&&item.word_count<=900,item.word_count);
  assert.ok((item.body.match(/^## /gm)||[]).length>=7);
  assert.equal(item.editorial_rubric.unsupported_promises,false);
 }
 for(let i=0;i<articles.length;i++)for(let j=i+1;j<articles.length;j++){
  assert.ok(jaccard(articles[i].body,articles[j].body)<0.5,
    "duplicated themes: "+topics[i][0]+" / "+topics[j][0]);
 }
});
