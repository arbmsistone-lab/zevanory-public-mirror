import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/arbm-sist.html',import.meta.url),'utf8');
const sitemap=await readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8');

test('ARBM SIST targets competitive search intent without false superiority claims',()=>{
  assert.match(html,/alternativa ao Codex/i);
  for(const term of ['Codex','Claude Code','Cursor','agentes de programação']) assert.match(html,new RegExp(term,'i'));
  assert.match(html,/Não existe um vencedor universal/i);
  assert.match(html,/Não necessariamente/i);
});

test('ARBM SIST preserves indexability and canonical discovery',()=>{
  assert.match(html,/name="robots" content="index,follow,max-image-preview:large"/);
  assert.match(html,/rel="canonical" href="https:\/\/zevanory\.api\.br\/arbm-sist"/);
  assert.match(sitemap,/https:\/\/zevanory\.api\.br\/arbm-sist/);
});

test('ARBM SIST exposes truthful SoftwareApplication structured data',()=>{
  assert.match(html,/"@type":"SoftwareApplication"/);
  assert.match(html,/"softwareVersion":"8\.1\.0"/);
  assert.match(html,/"operatingSystem":"Windows 10, Windows 11"/);
  assert.match(html,/"availability":"https:\/\/schema\.org\/PreOrder"/);
  assert.doesNotMatch(html,/aggregateRating|reviewCount|best|melhor que/i);
});