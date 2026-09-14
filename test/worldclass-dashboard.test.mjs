import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('executive hierarchy prioritizes glanceable truth',()=>{
  assert.match(html,/decision-meta/);assert.match(html,/nenhuma venda simulada/i);assert.match(html,/nenhuma previsão inventada/i);
  assert.equal((html.match(/<article><span>[^<]+<\/span><strong data-kpi=/g)||[]).length,5);
  assert.match(html,/Ver provas de excelência/);
});

test('elite certification is fail closed and evidence based',()=>{
  assert.match(js,/99%\+ CONFIÁVEL · 100% SENIOR ELITE/);assert.match(js,/NÃO CERTIFICADO/);
  for(const proof of ['releaseProof','evidenceProof','platformProof','autonomyProof','telemetryProof'])assert.match(js,new RegExp(proof));
  assert.match(js,/evidence_count\|\|0\)>=5/);assert.match(js,/organization_count\|\|0\)>=4/);
});

test('assurance summary retains the complete evidence path',()=>{
  for(const key of ['security_10x','observability_10x','architecture_20x','official_brand']) assert.match(js,new RegExp(key));
  assert.match(js,/assurance-summary/);assert.match(html,/id="audit-grid"/);
});

test('commercial switches preserve fail-closed color semantics',()=>{
  assert.match(css,/data-enabled="false"[^}]*amber/s);assert.match(css,/data-enabled="true"[^}]*red/s);
  assert.doesNotMatch(css,/data-enabled="false"[^}]*green/s);
});

test('EG0046 replaces simultaneous technical density with explicit detail',()=>{
  assert.match(css,/EG-0046 — progressive executive disclosure/);
  assert.match(css,/\.dialog-shell\{[^}]*overflow:auto/);assert.match(css,/html,body\{[^}]*overflow:hidden/);
});
