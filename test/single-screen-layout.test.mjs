import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');

test('single-screen architecture keeps executive domains visible',()=>{
  for(const name of ['Centro de decisão','Resumo executivo','Motor &amp; IA','Infraestrutura &amp; release','Garantias &amp; segurança']) assert.ok(html.includes(name));
  for(const klass of ['decision-center','executive-center','operations-rail','commercial-bar']) assert.ok(html.includes(`class="${klass}`));
});

test('desktop viewport remains structurally scroll-free',()=>{
  assert.ok(css.includes('overflow:hidden'));
  assert.ok(css.includes('height:100dvh'));
  assert.match(css,/grid-template-columns:minmax\(270px,\.58fr\) minmax\(520px,1\.34fr\) minmax\(420px,1\.08fr\)/);
  assert.match(css,/grid-template-columns:minmax\(250px,\.55fr\) minmax\(500px,1\.36fr\) minmax\(405px,1\.09fr\)/);
  assert.equal(css.includes('overflow:auto'),false);
});