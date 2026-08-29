import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');

test('EG0045 is the canonical premium visual system',()=>{
  assert.match(css,/EG-0045 — premium executive control room/);
  assert.equal(css.includes('EG-0044 — canonical executive visual system'),false);
});

test('compact desktop keeps a nine pixel visible floor',()=>{
  assert.match(css,/@media\(max-height:760px\)/);
  assert.match(css,/kpi-cluster span,.gate-card span,.mode-card span\{font-size:9px\}/);
  assert.match(css,/details-grid span\{font-size:9px\}/);
  assert.match(css,/rail-grid span\{font-size:9px\}/);
});

test('tall desktop promotes executive labels to ten pixels',()=>{
  assert.match(css,/@media\(min-height:761px\)/);
  assert.match(css,/commercial-label span,.commercial-facts span,.switches span,.switches b,footer\{font-size:10px\}/);
});

test('dynamic values are not ellipsized',()=>{
  assert.match(css,/details-grid b\{[^}]*white-space:normal[^}]*text-overflow:clip/);
  assert.match(css,/commercial-facts b\{[^}]*white-space:normal[^}]*text-overflow:clip/);
  assert.equal(css.includes('text-overflow:ellipsis'),false);
});