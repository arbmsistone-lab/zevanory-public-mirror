import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');

test('Cloudflare maps ELITE_INTERNAL_TOKEN to operator auth without exposing its value',()=>{
  assert.match(worker,/process\.env\.OPERATOR_TOKEN === undefined && process\.env\.ELITE_INTERNAL_TOKEN/);
  assert.match(worker,/process\.env\.OPERATOR_TOKEN = process\.env\.ELITE_INTERNAL_TOKEN/);
  assert.doesNotMatch(worker,/console\.log\([^\n]*ELITE_INTERNAL_TOKEN/);
});