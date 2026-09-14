import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {searchKnowledge} from '../src/knowledgeEngine.mjs';

test('knowledge query uses broad OR-prefix retrieval for natural customer language',async()=>{
  let captured;const sql={query:async(q,args)=>{captured={q:String(q),args};return [];}};
  await searchKnowledge(sql,'Quero saber como funciona o ARBM ONE no sal?o de beleza',10);
  assert.match(captured.q,/to_tsquery/);assert.match(captured.args[0],/arbm:\*/);assert.match(captured.args[0],/one:\*/);assert.match(captured.args[0],/\|/);
});

test('knowledge seed covers company ARBM SIST ARBM ONE and all five certified content products',()=>{
  const s=fs.readFileSync(new URL('../scripts/seed-agent-knowledge.mjs',import.meta.url),'utf8');
  for(const marker of ['ZEVANORY identidade e posicionamento','product:ARBM-SIST','products/support/','products/releases/v1.1/'])assert.ok(s.includes(marker),marker);
  const releases=fs.readdirSync(new URL('../products/releases/v1.1/',import.meta.url),{withFileTypes:true}).filter(x=>x.isDirectory()&&/^ZEV-/.test(x.name)).map(x=>x.name).sort();
  assert.deepEqual(releases,['ZEV-CMB-011','ZEV-IA-011','ZEV-LCX-011','ZEV-NGC-011','ZEV-VEN-011']);
});
