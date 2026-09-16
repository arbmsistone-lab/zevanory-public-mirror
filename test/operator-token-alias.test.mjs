import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hydrateRuntimeConfig } from '../src/runtimeConfigHydration.mjs';

const source=await readFile(new URL('../src/runtimeConfigHydration.mjs',import.meta.url),'utf8');

test('Cloudflare maps ELITE_INTERNAL_TOKEN to operator auth without exposing its value',()=>{
  const target={};hydrateRuntimeConfig({ELITE_INTERNAL_TOKEN:'fixture-secret'},target);
  assert.equal(target.OPERATOR_TOKEN,'fixture-secret');
  assert.doesNotMatch(source,/console\.log\([^\n]*ELITE_INTERNAL_TOKEN/);
});
