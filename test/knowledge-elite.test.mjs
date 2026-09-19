import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {searchKnowledge} from '../src/knowledgeEngine.mjs';

test('knowledge query uses broad OR-prefix retrieval for natural customer language',async()=>{
  let captured;const sql={query:async(q,args)=>{captured={q:String(q),args};return [];}};
  await searchKnowledge(sql,'Quero saber como funciona o ZEVANORY ONE no salao de beleza',10);
  assert.match(captured.q,/to_tsquery/);assert.match(captured.args[0],/zevanory:\*/);assert.match(captured.args[0],/one:\*/);assert.match(captured.args[0],/\|/);
});

test('knowledge seed covers company ARBM SIST ZEVANORY ONE ARBM Contador and all certified content products',()=>{
  const s=fs.readFileSync(new URL('../scripts/seed-agent-knowledge.mjs',import.meta.url),'utf8');
  for(const marker of ['ZEVANORY identidade e posicionamento','ZEVANORY-PRODUCTS-V21-HANDOFF.md','product:ARBM-SIST','entry.isFile()','products/support/${product.name}/${entry.name}','products/support/','products/releases/${productRelease}/','active=false'])assert.ok(s.includes(marker),marker);
  const releases=fs.readdirSync(new URL('../products/releases/v2.1/',import.meta.url),{withFileTypes:true}).filter(x=>x.isDirectory()&&/^ZEV-/.test(x.name)).map(x=>x.name).sort();
  assert.deepEqual(releases,['ZEV-CMB-011','ZEV-IA-011','ZEV-LCX-011','ZEV-NGC-011','ZEV-VEN-011']);
});
