import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../public/tiktok-review.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/tiktok-review.js',import.meta.url),'utf8');
const vercel=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));

test('TikTok review surface is noindex and uses isolated review OAuth',()=>{
  assert.match(html,/noindex,nofollow,noarchive/);
  assert.match(html,/\/api\/oauth\/tiktok\/start\?mode=review/);
  assert.match(html,/Produção continua bloqueada/i);
  assert.match(html,/TikTok's Music Usage Confirmation/);
  assert.doesNotMatch(html,/Submeter para revisão/i);
});

test('TikTok review UX follows creator-driven privacy and interaction rules',()=>{
  assert.match(html,/Selecione manualmente/);
  assert.match(html,/Permitir comentários/);assert.match(html,/Permitir Duet/);assert.match(html,/Permitir Stitch/);
  assert.match(html,/Sua marca/);assert.match(html,/parceria paga/);assert.match(html,/Conteúdo gerado por IA/);
  assert.match(js,/privacyLevelOptions/);assert.match(js,/commentDisabled/);assert.match(js,/duetDisabled/);assert.match(js,/stitchDisabled/);
  assert.match(js,/\/api\/tiktok-review/);assert.doesNotMatch(js,/post\/publish\/video\/init/);
});

test('TikTok review route is explicit in Vercel',()=>{const route=vercel.rewrites.find(r=>r.source==='/tiktok-review');assert.deepEqual(route,{source:'/tiktok-review',destination:'/public/tiktok-review.html'});});
