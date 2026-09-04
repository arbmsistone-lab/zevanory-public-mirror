import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../public/tiktok-review.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/tiktok-review.js',import.meta.url),'utf8');
const vercel=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));

test('TikTok review surface is noindex and review-only',()=>{
  assert.match(html,/noindex,nofollow,noarchive/);
  assert.match(html,/\/api\/oauth\/tiktok\/start/);
  assert.match(html,/consentimento explícito/i);
  assert.doesNotMatch(html,/Submeter para revisão/i);
});

test('TikTok review validation fails closed before any provider action',()=>{
  assert.match(js,/if\(!consent\)/);
  assert.match(js,/protocol==='https:'/);
  assert.match(js,/publicação real permanece sujeita ao OAuth e aos gates do servidor/i);
  assert.doesNotMatch(js,/post\/publish\/video\/init/);
});

test('TikTok review route is explicit in Vercel',()=>{
  const route=vercel.rewrites.find(r=>r.source==='/tiktok-review');
  assert.deepEqual(route,{source:'/tiktok-review',destination:'/public/tiktok-review.html'});
});