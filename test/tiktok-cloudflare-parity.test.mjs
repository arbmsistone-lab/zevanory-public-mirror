import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Cloudflare Worker preserves TikTok OAuth start and callback routes', async()=>{
  const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
  assert.match(worker,/\/api\/oauth\/tiktok\/start/);
  assert.match(worker,/\/api\/oauth\/tiktok\/callback/);
  assert.match(worker,/provider', 'tiktok_oauth'/);
  assert.match(worker,/action', 'start'/);
});

test('TikTok canonical migration and repair migration allow isolated sandbox credentials', async()=>{
  const canonical=await readFile(new URL('../db/migrations/018_tiktok_oauth.sql',import.meta.url),'utf8');
  const repair=await readFile(new URL('../db/migrations/019_tiktok_sandbox_provider.sql',import.meta.url),'utf8');
  for(const sql of [canonical,repair]){
    assert.match(sql,/'mercado_livre'/);
    assert.match(sql,/'tiktok'/);
    assert.match(sql,/'tiktok_sandbox'/);
  }
});
