import test from 'node:test';
import assert from 'node:assert/strict';
import * as blog from '../worker/multichannel-autonomy.mjs';
import {dailyEditorialArticle} from '../worker/blog-editorial.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../worker/multichannel-autonomy.mjs',import.meta.url),day='2026-11-11',now=new Date(day+'T15:00:00Z');
async function legacy(mod){
 const old={slug:'legacy',title:'Legado reconhecível'};
 const valid=Array.from({length:45},(_,i)=>({slug:'prior-'+i,title:'Anterior '+i,body:'Corpo antigo independente '+i}));
 const data=new Map([[blog.BLOG_INDEX_KEY,JSON.stringify({articles:[old,...valid]})]]);
 const kv={get:async k=>data.get(k)??null,put:async(k,v)=>data.set(k,v)};
 const out=await mod.ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:kv},now);
 assert.equal(out.reason,'published');assert.equal(out.status.indice_entradas_ignoradas,1);
 assert.deepEqual(JSON.parse(data.get(blog.BLOG_INDEX_KEY)).articles.find(a=>a?.slug==='legacy'),old);
 assert.equal(JSON.parse(data.get(blog.BLOG_INDEX_KEY)).articles.filter(blog.validBlogIndexArticle).length,45);
}
async function rebuild(mod,fail=false){
 const article=dailyEditorialArticle('2026-11-09'),data=new Map([[blog.BLOG_INDEX_KEY,'{corrompido'],[blog.BLOG_STATUS_PREFIX+'2026-11-09',JSON.stringify({resultado:'ok',slug:article.slug})],['zpc:blog:article:'+article.slug,JSON.stringify(article)]]),writes=[];
 const kv={get:async k=>{if(fail&&k===blog.BLOG_STATUS_PREFIX+'2026-10-01')throw Error('source');return data.get(k)??null;},put:async(k,v)=>{writes.push(k);data.set(k,v);}};
 const out=await mod.ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:kv},now);
 if(fail){assert.match(out.reason,/kv_leitura_invalida:indice/);assert.deepEqual(writes,[]);assert.equal(data.get(blog.BLOG_INDEX_KEY),'{corrompido');}
 else{assert.equal(out.reason,'published');assert.equal(out.status.indice_reconstruido,true);assert.ok(JSON.parse(data.get(blog.BLOG_INDEX_KEY)).articles.some(a=>a?.slug===article.slug));}
}
test('CL1020 recognized legacy without body survives publication and the 45-article cap',()=>legacy(blog));
test('CL1020 majority corrupted entries without recovery evidence stays blocked',async()=>{
 const writes=[],data=new Map([[blog.BLOG_INDEX_KEY,JSON.stringify({articles:[null,{}, {slug:'good',title:'Good',body:'Good body'}]})]]);
 const out=await blog.ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:{get:async k=>data.get(k)??null,put:async k=>writes.push(k)}},now);
 assert.equal(out.reason,'kv_leitura_invalida:indice:maioria');assert.deepEqual(writes,[]);
});
test('CL1020 corrupted container is rebuilt from 105 days of readable status/article sources',()=>rebuild(blog));
test('CL1020 one unreadable source prevents all writes',()=>rebuild(blog,true));
test('CL1020 mutant: discard legacy entries',async()=>{await legacy(blog);await killedMutation(source,[['...index.articles.filter(x=>!validBlogIndexArticle(x)),','']],legacy);});
test('CL1020 mutant: accept non-object container as empty',async()=>{const sc=m=>rebuild(m,true);await sc(blog);await killedMutation(source,[['if(!r.ok)indexError=r.erro;','if(!r.ok&&nome==="indice"){lido.indice={articles:[]};continue;}']],sc);});
test('CL1020 mutant: recover despite a failed source',async()=>{const sc=m=>rebuild(m,true);await sc(blog);await killedMutation(source,[['if(!status.ok)return {ok:false};','if(!status.ok)continue;']],sc);});
