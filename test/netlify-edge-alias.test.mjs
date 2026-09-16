import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker=readFileSync(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
const netlify=readFileSync(new URL('../netlify.toml',import.meta.url),'utf8');

test('edge accepts both robot control route spellings',()=>{
  assert.match(worker,/\['\/api\/robot\/control', robotControlHandler\]/);
  assert.match(worker,/\['\/api\/robot-control', robotControlHandler\]/);
});

test('netlify standby robot control proxy maps to an edge-supported route',()=>{
  assert.match(netlify,/from = "\/api\/robot-control"/);
  assert.match(netlify,/to = "https:\/\/zevanory\.zevanory\.workers\.dev\/api\/robot-control"/);
});
