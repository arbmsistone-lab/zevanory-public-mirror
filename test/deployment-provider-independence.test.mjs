import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const netlify=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');
const wrangler=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');
const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');

test('Netlify standby has no Vercel runtime dependency',()=>{
  assert.doesNotMatch(netlify,/zevanory-site\.vercel\.app/i);
  assert.match(netlify,/https:\/\/zevanory\.zevanory\.workers\.dev\/api\//i);
});

test('Cloudflare runtime keeps canonical fail-closed commercial controls',()=>{
  assert.match(wrangler,/"CHECKOUT_ENABLED"\s*:\s*"false"/);
  assert.match(wrangler,/"FINANCIAL_EVENTS_ENABLED"\s*:\s*"false"/);
  assert.match(wrangler,/"SALE_GLOBALLY_ENABLED"\s*:\s*"false"/);
  assert.match(wrangler,/"PRE_SALE_GATES_APPROVED"\s*:\s*"false"/);
});

test('Cloudflare build isolates heavyweight creative runtime',()=>{
  assert.match(wrangler,/"@playwright\/test"\s*:\s*"\.\/src\/cloudflare-stubs\/playwright\.mjs"/);
  assert.match(wrangler,/"@sparticuz\/chromium"\s*:\s*"\.\/src\/cloudflare-stubs\/chromium\.mjs"/);
});
test('Cloudflare keeps generic payment delegation loop-safe but does not bind production to Vercel',()=>{
  assert.match(worker,/delegatePaymentRequest\(request,env\)/);
  assert.match(worker,/x-zevanory-payment-delegated/);
  assert.match(worker,/payment_delegation_loop_blocked/);
  assert.match(worker,/PAYMENT_RUNTIME_ALLOWED_ORIGINS/);
  assert.doesNotMatch(wrangler,/zevanory-site\.vercel\.app/i);
});

test('Cloudflare exposes an independent production custom domain',()=>{
  assert.match(wrangler,/"pattern"\s*:\s*"edge\.zevanory\.api\.br"/);
  assert.match(wrangler,/"custom_domain"\s*:\s*true/);
  assert.doesNotMatch(wrangler,/"REMOTE_CHANNEL_STATUS_URL"/);
});

test('Cloudflare owns canonical APIs including OAuth',()=>{
  const canonicalWildcard=wrangler.includes('zevanory.api.br/*');
  for(const route of ['health','live','status','release','config','assurance','activation/','events/','agent/','checkout/','webhooks/','oauth/','robot-control']) assert.ok(canonicalWildcard||wrangler.includes(`zevanory.api.br/api/${route}`));
  assert.doesNotMatch(worker,/delegateTikTokOAuthRequest/);
});

test('Cloudflare owns canonical static assets and TikTok review surface',()=>{
  const canonicalWildcard=wrangler.includes('zevanory.api.br/*');
  for(const route of ['zevanory.api.br/','zevanory.api.br/index.html','zevanory.api.br/index.js','zevanory.api.br/index.css','zevanory.api.br/brand/*','zevanory.api.br/api/tiktok-review*']) assert.ok(canonicalWildcard||wrangler.includes(route));
  assert.match(worker,/\['\/tiktok-review', '\/tiktok-review\.html'\]/);
});