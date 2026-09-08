import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server=fs.readFileSync('src/server-v2.mjs','utf8');
const render=fs.readFileSync('render.yaml','utf8');

test('local host remains loopback by default',()=>{
  assert.match(server,/process\.env\.HOST \|\| "127\.0\.0\.1"/);
  assert.match(server,/server\.listen\(port, host/);
});

test('Render standby is free and externally bindable',()=>{
  assert.match(render,/plan: free/);
  assert.match(render,/key: HOST[\s\S]*value: 0\.0\.0\.0/);
  assert.match(render,/healthCheckPath: \/api\/live/);
  assert.match(render,/startCommand: npm start/);
});