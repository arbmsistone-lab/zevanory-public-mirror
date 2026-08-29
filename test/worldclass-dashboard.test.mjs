import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('executive hierarchy reduces visual competition without losing truth',()=>{
  assert.match(html,/decision-meta/);
  assert.match(html,/nenhuma venda simulada/i);
  assert.equal((html.match(/<article><span>[^<]+<\/span><strong data-kpi=/g)||[]).length,7);
  assert.match(html,/class="hidden-runtime" data-kpi="offers_sent"/);
});

test('assurance view is executive while complete evidence remains available',()=>{
  for(const key of ['security_10x','observability_10x','dr_10x','architecture_20x','official_brand','rules_audit_20x']) assert.match(js,new RegExp(key));
  assert.match(js,/assurance-summary/);
  assert.match(js,/rail\.title=entries/);
});

test('commercial switches cannot visually look enabled when false',()=>{
  assert.match(css,/data-enabled="false"[^}]*amber/s);
  assert.match(css,/data-enabled="true"[^}]*red/s);
  assert.doesNotMatch(css,/data-enabled="false"[^}]*green/s);
});

test('world-class single-screen override preserves closed viewport',()=>{
  assert.match(css,/EG-0041/);
  assert.match(css,/grid-template-columns:minmax\(330px,\.78fr\) minmax\(0,1\.32fr\) minmax\(300px,\.84fr\)/);
  assert.equal(css.includes('overflow:auto'),false);
});