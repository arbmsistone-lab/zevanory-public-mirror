import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const worker=await readFile(new URL('../public/_worker.js',import.meta.url),'utf8');
const headers=await readFile(new URL('../public/_headers',import.meta.url),'utf8');
const build=await readFile(new URL('../scripts/build-cloudflare-pages-static.mjs',import.meta.url),'utf8');

test('Cloudflare Pages is an explicit Vercel-independent static deploy path',()=>{
  assert.match(pkg.scripts['deploy:pages:static'],/wrangler pages deploy \.pages-dist/);
  assert.match(pkg.scripts['deploy:pages:static'],/zevanory-static/);
});

test('Pages worker proxies API to independent Cloudflare edge and serves local assets',()=>{
  assert.match(worker,/https:\/\/edge\.zevanory\.api\.br/);
  assert.match(worker,/url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker,/env\.ASSETS\.fetch\(request\)/);
});

test('static artifact preserves clean creative route and strict browser headers',()=>{
  assert.match(build,/['"]criativos['"]/);
  assert.match(build,/index\.html/);
  assert.match(headers,/Content-Security-Policy/);
  assert.match(headers,/X-Frame-Options: DENY/);
});
