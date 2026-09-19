import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src=fs.readFileSync(new URL('../src/deno-failover.mjs',import.meta.url),'utf8');

test('Deno failover is independent and fail-closed by construction',()=>{
  assert.match(src,/provider:"deno-deploy"/);
  assert.match(src,/databaseHealth/);
  assert.match(src,/npm:@neondatabase\/serverless@1\.1\.0/);
  assert.match(src,/failover_readonly/);
  assert.match(src,/SALE_GLOBALLY_ENABLED:"false"/);
  assert.match(src,/CHECKOUT_ENABLED:"false"/);
  assert.match(src,/FINANCIAL_EVENTS_ENABLED:"false"/);
  assert.doesNotMatch(src,/edge\.zevanory\.api\.br|netlify\.app|vercel\.app/);
});

test('Deno failover exposes exact-SHA health and control-plane endpoints',()=>{
  for(const route of ['/api/health','/api/release','/api/config','/api/control-plane']) assert.match(src,new RegExp(route.replaceAll('/','\\/')));
  assert.match(src,/\^\[0-9a-f\]\{40\}\$/);
  assert.match(src,/commercial_safety_locked:!publicSales/);
});

test('Deno failover rejects all write methods',()=>{
  assert.match(src,/method!==\"GET\"&&method!==\"HEAD\"/);
  assert.match(src,/return json\(\{error:\"failover_readonly\",provider:\"deno-deploy\"\},503\)/);
});
