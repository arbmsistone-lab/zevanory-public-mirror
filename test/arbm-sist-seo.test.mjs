import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const html=await readFile(new URL('../public/arbm-sist.html',import.meta.url),'utf8');
const sitemap=await readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8');

test('ARBM SIST targets competitive search intent without false superiority claims',()=>{
  assert.match(html,/alternativa ao Codex/i);
  for(const term of ['Codex','Claude Code','Cursor','agentes de programação']) assert.match(html,new RegExp(term,'i'));
  assert.match(html,/agente de IA local para Windows/i);
  assert.match(html,/Não existe um vencedor universal/i);
  assert.match(html,/Não necessariamente/i);
  assert.match(html,/processo auditável/i);
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
  assert.match(html,/"dateModified":"2026-08-31"/);
  assert.doesNotMatch(html,/aggregateRating|reviewCount|best|melhor que/i);
});

test('ARBM SIST has professional social sharing and accessibility metadata',async()=>{
  assert.match(html,/name="theme-color" content="#080b10"/);
  assert.match(html,/property="og:image" content="\/brand\/arbm-sist-social\.png"/);
  assert.match(html,/name="twitter:card" content="summary_large_image"/);
  assert.match(html,/twitter:image:alt/);
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/width="168" height="36" decoding="async"/);
  const card=await stat(new URL('../public/brand/arbm-sist-social.png',import.meta.url));
  assert.ok(card.size>10000);
});
