import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const netlify=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');
const wrangler=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');
const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');

test('Netlify standby has no Vercel runtime dependency',()=>{
  assert.doesNotMatch(netlify,/https:\/\/zevanory\.api\.br\/api\//i);
  assert.doesNotMatch(netlify,/girolocal-rb\.workers\.dev/i);
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

test('Cloudflare delegated payment is real and loop-safe',()=>{
  assert.match(worker,/delegatePaymentRequest\(request,env\)/);
  assert.match(worker,/x-zevanory-payment-delegated/);
  assert.match(worker,/payment_delegation_loop_blocked/);
  assert.match(worker,/PAYMENT_RUNTIME_ALLOWED_ORIGINS/);
});

test('Cloudflare exposes an independent production custom domain',()=>{
  assert.match(wrangler,/"pattern"\s*:\s*"edge\.zevanory\.api\.br"/);
  assert.match(wrangler,/"custom_domain"\s*:\s*true/);
  assert.match(wrangler,/"PAYMENT_RUNTIME_ORIGIN"\s*:\s*"https:\/\/zevanory-site\.vercel\.app"/);
  assert.doesNotMatch(wrangler,/"PAYMENT_RUNTIME_ORIGIN"\s*:\s*"https:\/\/zevanory\.api\.br"/);
});
test('Cloudflare failover owns critical main-domain APIs but not OAuth',()=>{
  for(const route of ['health','live','status','release','config','assurance','activation/','events/','agent/','checkout/','webhooks/','robot-control']) {
    assert.ok(wrangler.includes(`zevanory.api.br/api/${route}`));
  }
  assert.doesNotMatch(wrangler,/zevanory\.api\.br\/api\/oauth/i);
});
test('Cloudflare owns canonical main-domain static assets while OAuth remains outside',()=>{
  for(const route of ['zevanory.api.br/','zevanory.api.br/index.html','zevanory.api.br/index.js','zevanory.api.br/index.css','zevanory.api.br/brand/*']) assert.ok(wrangler.includes(route));
  assert.doesNotMatch(wrangler,/zevanory\.api\.br\/api\/oauth/i);
});
