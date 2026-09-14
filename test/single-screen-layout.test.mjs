import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');

test('single-screen primary surface keeps current executive domains visible',()=>{
  for(const name of ['Centro de decisão','Resumo executivo','Operação ao vivo','Prontidão comercial','Confiabilidade &amp; excelência','Garantias']) assert.ok(html.includes(name));
  for(const klass of ['decision-center','business-center','readiness-rail','governance-bar']) assert.ok(html.includes(`class="${klass}`));
});

test('desktop primary surface stays scroll-free with explicit detail disclosure',()=>{
  assert.match(css,/html,body\{[^}]*overflow:hidden/);
  assert.ok(css.includes('height:100dvh'));
  assert.match(css,/grid-template-columns:minmax\(300px,\.82fr\) minmax\(470px,1\.22fr\) minmax\(310px,\.86fr\)/);
  assert.match(html,/id="open-details"/);assert.match(html,/id="details-dialog"/);
  assert.match(css,/\.dialog-shell\{[^}]*overflow:auto/);
});
