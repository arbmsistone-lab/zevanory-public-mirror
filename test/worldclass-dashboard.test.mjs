import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('executive hierarchy keeps seven primary KPIs and real commercial truth',()=>{
  assert.equal((html.match(/<article><span>[^<]+<\/span><strong data-kpi=/g)||[]).length,7);
  assert.match(html,/nenhuma venda simulada/i);
  assert.match(html,/nenhuma previsão inventada/i);
});

test('assurance summary retains complete evidence path',()=>{
  for(const key of ['security_10x','observability_10x','architecture_20x','official_brand']) assert.match(js,new RegExp(key));
  assert.match(js,/assurance-summary/); assert.match(js,/rail\.title=entries/);
});

test('commercial switches preserve fail-closed color semantics',()=>{
  assert.match(css,/data-enabled="false"\] b\{color:var\(--amber\)/);
  assert.match(css,/data-enabled="true"\] b\{color:var\(--red\)/);
});

test('EG0044 replaces historical visual override stack',()=>{
  assert.match(css,/EG-0044 — canonical executive visual system/);
  assert.equal(css.includes('EG-0043.'),false);
  assert.equal(css.includes('overflow:auto'),false);
});
