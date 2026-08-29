import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('EG0043 redistributes width toward operational rail',()=>{
  assert.match(css,/minmax\(300px,\.70fr\).*minmax\(355px,1\.02fr\)/s);
  assert.match(css,/minmax\(285px,\.68fr\).*minmax\(340px,1\.04fr\)/s);
});

test('EG0043 keeps all operational rail fields visible',()=>{
  assert.ok(css.includes('no operational truth hidden'));
  assert.ok(css.includes('visibility:visible'));
  assert.ok(css.includes('grid-template-columns:repeat(3,minmax(0,1fr))'));
});

test('secondary rail information remains accessible as tooltip truth',()=>{
  assert.ok(js.includes('engineRail.title='));
  assert.ok(js.includes('infraRail.title='));
  assert.ok(js.includes('Outbound:'));
  assert.ok(js.includes('Persistência rollback:'));
});

test('commercial facts are never ellipsized in final certification',()=>{
  assert.ok(css.includes('.commercial-facts b{white-space:normal;overflow:visible;text-overflow:clip'));
});