import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('NubeSDK bundle exports non-invasive App entrypoint', async()=>{
  const url=new URL('../public/integrations/nuvemshop/nube-app.min.js',import.meta.url);
  const source=await readFile(url,'utf8');
  assert.match(source,/export function App\(/);
  assert.doesNotMatch(source,/\b(document|window|localStorage|sessionStorage)\b/);
  const mod=await import(url.href);
  assert.equal(typeof mod.App,'function');
  assert.doesNotThrow(()=>mod.App({}));
});

test('NubeSDK TypeScript source follows official App(nube) model', async()=>{
  const source=await readFile(new URL('../nuvemshop-nubesdk/src/main.ts',import.meta.url),'utf8');
  assert.match(source,/NubeSDK/);
  assert.match(source,/export function App\(nube: NubeSDK\)/);
  assert.doesNotMatch(source,/\b(document|window|localStorage|sessionStorage)\b/);
});
