import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('EG0045 gives operational rail enough real width',()=>{
  assert.match(css,/minmax\(420px,1\.08fr\)/);assert.match(css,/minmax\(405px,1\.09fr\)/);
});

test('operational rail fields are never hidden to make layout fit',()=>{
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.equal(css.includes('.engine-rail .rail-grid div{display:none}'),false);
  assert.equal(css.includes('.infra-rail .rail-grid div{display:none}'),false);
  assert.equal(css.includes('.agent-line{display:none}'),false);
});

test('assurance remains compact but visible',()=>{
  assert.ok(css.includes('.audit-grid>div:not(.assurance-summary)'));
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) auto'));
});

test('secondary evidence remains available as tooltip truth',()=>{
  assert.ok(js.includes('engineRail.title='));assert.ok(js.includes('infraRail.title='));
});

test('commercial facts are never ellipsized',()=>{
  assert.match(css,/commercial-facts b\{[^}]*text-overflow:clip/);
});