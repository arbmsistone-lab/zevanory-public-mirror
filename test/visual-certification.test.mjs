import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('EG0044 gives operational rail enough real width',()=>{
  assert.match(css,/minmax\(410px,1\.04fr\)/);
  assert.match(css,/minmax\(405px,1\.06fr\)/);
});

test('all operational rail fields remain visible',()=>{
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.equal(css.includes('visibility:hidden'),false);
  assert.equal(css.includes('.agent-line{display:none}'),false);
});

test('assurance remains compact but visible',()=>{
  assert.match(css,/\.audit-grid>div:not\(\.assurance-summary\)/);
  assert.match(css,/grid-template-columns:minmax\(0,1fr\) auto/);
});

test('host and labels are presentation-consistent',()=>{
  assert.match(js,/surface-host/);
  assert.match(js,/switchLabels/);
  assert.match(js,/assuranceLabels/);
});
