import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');

test('EG0044 uses one canonical visual system',()=>{
  assert.match(css,/EG-0044 — canonical executive visual system/);
  assert.equal(css.includes('EG-0043.'),false);
  assert.equal(css.includes('overflow:auto'),false);
});

test('compact desktop keeps a nine pixel floor',()=>{
  assert.match(css,/kpi-cluster span,.gate-card span,.mode-card span\{font-size:9px/);
  assert.match(css,/details-grid span\{font-size:9px/);
  assert.match(css,/rail-grid span\{font-size:9px/);
});

test('tall desktop raises executive labels to ten pixels',()=>{
  assert.match(css,/@media\(min-height:761px\)/);
  assert.match(css,/header-state,.eyebrow,.priority-callout span\{font-size:10px\}/);
});

test('dynamic values wrap without ellipsis',()=>{
  assert.match(css,/details-grid b\{[^}]*white-space:normal[^}]*text-overflow:clip/);
  assert.match(css,/commercial-facts b\{[^}]*white-space:normal[^}]*text-overflow:clip/);
  assert.match(html,/id="surface-host"/);
});
