import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
const wrangler=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));

test('Cloudflare exposes canonical control-plane through build-generated certification asset',()=>{
  assert.match(worker,/url\.pathname==='\/api\/control-plane'/);
  assert.match(worker,/control-plane-certification\.json/);
  assert.match(worker,/buildControlPlaneSnapshot\(env,certification\)/);
  assert.match(worker,/ZEVANORY_RELEASE_SHA/);
});

test('Cloudflare base config has no stale hardcoded deployment SHA',()=>{
  assert.equal(Object.hasOwn(wrangler.vars||{},'PUBLIC_RELEASE_SHA'),false);
  assert.equal(Object.hasOwn(wrangler.vars||{},'ZEVANORY_RELEASE_SHA'),false);
});

test('Cloudflare production header binds only runtime canonical release SHA',()=>{
  assert.match(worker,/x-deployment-sha[^\n]+ZEVANORY_RELEASE_SHA/);
  assert.doesNotMatch(worker,/x-deployment-sha[^\n]+PUBLIC_RELEASE_SHA/);
});
