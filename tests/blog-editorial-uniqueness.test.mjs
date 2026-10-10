import test from "node:test";
import assert from "node:assert/strict";
import {longFormDailyArticle} from "../worker/multichannel-autonomy.mjs";
function trigrams(s){const words=String(s).toLocaleLowerCase("pt-BR").match(/[\\p{L}\\p{N}]+/gu)||[];return new Set(words.slice(0,-2).map((_,i)=>words.slice(i,i+3).join(" ")));}
function jaccard(a,b){const aa=trigrams(a),bb=trigrams(b);const intersection=[...aa].filter(x=>bb.has(x)).length;return intersection/(aa.size+bb.size-intersection);}
test("daily posts for distinct business topics must not be near-duplicates",()=>{
 const one=longFormDailyArticle({slug:"ia-pratica-pequenos-negocios",title:"IA prática para pequenos negócios",description:"Organização de tarefas"},"2026-10-10");
 const two=longFormDailyArticle({slug:"caixa-comercio-juazeiro-do-norte",title:"Caixa do comércio em Juazeiro do Norte",description:"Entradas e saídas"},"2026-10-11");
 for(const a of [one,two]){assert.ok(a.word_count>=600&&a.word_count<=900);assert.match(a.body,/## /);assert.equal(a.editorial_rubric.unsupported_promises,false);}
 assert.ok(jaccard(one.body,two.body)<0.5,"duplicated daily editorial body");
});
