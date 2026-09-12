import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Cloudflare Worker owns TikTok OAuth start callback and review routes without Vercel delegation', async()=>{
  const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
  assert.match(worker,/\/api\/oauth\/tiktok\/start/);
  assert.match(worker,/\/api\/oauth\/tiktok\/callback/);
  assert.match(worker,/provider', 'tiktok_oauth'/);
  assert.match(worker,/action', 'start'/);
  assert.match(worker,/\/api\/tiktok-review/);
  assert.match(worker,/provider', 'tiktok_review'/);
  assert.doesNotMatch(worker,/zevanory-site\.vercel\.app/);
  assert.doesNotMatch(worker,/delegateTikTokOAuthRequest/);
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
test('Cloudflare Worker preserves Mercado Livre OAuth failover routes', async()=>{
  const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
  const oauth=await readFile(new URL('../src/mercadoLivreOAuth.mjs',import.meta.url),'utf8');
  assert.match(worker,/\/api\/oauth\/mercadolivre\/start/);
  assert.match(worker,/\/api\/oauth\/mercadolivre\/callback/);
  assert.match(worker,/provider', 'mercadolivre_oauth'/);
  assert.match(oauth,/MERCADOLIVRE_REDIRECT_URI/);
  assert.match(oauth,/DEFAULT_REDIRECT_URI/);
});