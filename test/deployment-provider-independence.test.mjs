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

test('Cloudflare runtime keeps pilot-safe commercial controls',()=>{
  assert.match(wrangler,/"CHECKOUT_ENABLED"\s*:\s*"true"/);
  assert.match(wrangler,/"FINANCIAL_EVENTS_ENABLED"\s*:\s*"true"/);
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