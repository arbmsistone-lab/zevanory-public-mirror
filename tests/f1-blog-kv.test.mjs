import test from 'node:test';
import assert from 'node:assert/strict';
import * as blog from '../worker/multichannel-autonomy.mjs';
import * as gate from '../worker/blog-quality-gate.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../worker/multichannel-autonomy.mjs',import.meta.url),gateSource=new URL('../worker/blog-quality-gate.mjs',import.meta.url);
const day='2026-11-11',now=new Date(day+'T15:00:00Z');
async function readFailure(mod,marker='legacy',failure='throw'){
 const articleKey='zpc:blog:article:published';
 const data=new Map([[marker==='legacy'?'zpc:blog:daily:'+day:blog.BLOG_STATUS_PREFIX+day,JSON.stringify(marker==='legacy'?{slug:'published'}:{resultado:'ok',slug:'published',url:'https://zevanory.api.br/blog/published',at:now.toISOString()})],[blog.BLOG_INDEX_KEY,JSON.stringify({articles:[]})]]),writes=[];
 const kv={get:async k=>{if(k===articleKey){if(failure==='throw')throw Error('read');return failure;}return data.get(k)??null;},put:async k=>writes.push(k)};
 const result=await mod.ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:kv},now,async()=>{throw Error('unexpected fetch');});
 assert.equal(result.latest,null);assert.match(result.reason,/^kv_leitura_invalida:artigo:/);assert.deepEqual(writes,[]);
}
test('A3 article referenced by a marker must be readable, present and valid',async()=>{
 for(const marker of ['legacy','status'])for(const failure of ['throw','{broken','{}',null])await readFailure(blog,marker,failure);
});
test('A3 malformed gate structures never write',async()=>{
 for(const [key,raw] of [[blog.BLOG_INDEX_KEY,{articles:[{slug:'old'}]}],['zpc:blog:daily:'+day,{}],[blog.BLOG_STATUS_PREFIX+day,{resultado:'ok'}],['zpc:creative-autonomy:paused:v1','wrong']]){
  const writes=[],kv={get:async k=>k===key?(typeof raw==='string'?raw:JSON.stringify(raw)):null,put:async k=>writes.push(k)};
  const result=await blog.ensureDailyBlog({ZEVANORY_PRIVATE_ARTIFACTS:kv},now);
  assert.match(result.reason,/kv_leitura_invalida/);assert.deepEqual(writes,[]);
 }
});
test('A3 mutant: legacy article read fails open',async()=>{
 await readFailure(blog);
 await killedMutation(source,[['if(!existing.ok||!existing.v)return {created:[],latest:null,day,reason:"kv_leitura_invalida:artigo:"+(!existing.ok?existing.erro:"ausente")};\n    return {created:[],latest:existing.v,day,reason:"already_published"};','return {created:[],latest:existing.v,day,reason:"already_published"};']],readFailure);
});
async function explicitPort(mod){for(const url of ['https://www.ibge.gov.br:443/x','https://www.ibge.gov.br:8443/x'])assert.equal(mod.verifiableSource(url),false,url);assert.equal(mod.verifiableSource('https://www.ibge.gov.br/x'),true);}
test('A3 explicit port including normalized HTTPS default is forbidden',()=>explicitPort(gate));
test('A3 mutant: normalized default port accepted',async()=>{
 await explicitPort(gate);
 await killedMutation(gateSource,[[' || authority.includes(":")','']],explicitPort);
});
