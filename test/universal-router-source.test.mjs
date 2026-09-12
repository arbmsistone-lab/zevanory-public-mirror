import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const src=await readFile(new URL('../infra/supabase/zevanory-universal-router-v1/index.ts',import.meta.url),'utf8');

test('router uses Cloudflare fast path with Netlify read fallback and no Vercel dependency',()=>{
  assert.match(src,/edge\.zevanory\.api\.br/);
  assert.match(src,/zevanory-production-backup\.netlify\.app/);
  assert.doesNotMatch(src,/zevanory-site\.vercel\.app/);
  assert.match(src,/primary\.status<500/);
  assert.match(src,/fast-primary-read-failover/);
});

test('router never blindly retries mutations',()=>{
  const block=src.match(/if\(!READ_METHODS\.has\(req\.method\)\)\{([\s\S]*?)\r?\n  \}\r?\n  try\{/i)?.[1]||'';
  assert.match(block,/mutation_origin_unavailable/);
  assert.match(block,/preserved:true,retried:false/);
  assert.match(block,/ORIGINS\[0\]/);
  assert.doesNotMatch(block,/ORIGINS\[1\]/);
});