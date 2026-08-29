import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('executive hierarchy reduces visual competition without losing truth',()=>{
  assert.match(html,/decision-meta/);
  assert.match(html,/nenhuma venda simulada/i);
  assert.equal((html.match(/<article><span>[^<]+<\/span><strong data-kpi=/g)||[]).length,7);
});

test('assurance summary retains complete evidence path',()=>{
  for(const key of ['security_10x','observability_10x','architecture_20x','official_brand']) assert.match(js,new RegExp(key));
  assert.match(js,/assurance-summary/);assert.match(js,/rail\.title=entries/);
});

test('commercial switches preserve fail-closed color semantics',()=>{
  assert.match(css,/data-enabled="false"[^}]*amber/s);
  assert.match(css,/data-enabled="true"[^}]*red/s);
  assert.doesNotMatch(css,/data-enabled="false"[^}]*green/s);
});

test('EG0045 replaces the previous canonical visual generation',()=>{
  assert.match(css,/EG-0045 — premium executive control room/);
  assert.equal(css.includes('EG-0044 — canonical executive visual system'),false);
  assert.equal(css.includes('overflow:auto'),false);
});