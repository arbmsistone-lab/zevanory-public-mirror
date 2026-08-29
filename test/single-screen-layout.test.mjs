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
  assert.ok(css.includes('height:100dvh'));
  assert.ok(css.includes('overflow:hidden'));
  assert.match(css,/grid-template-columns:minmax\(285px,\.66fr\) minmax\(500px,1\.30fr\) minmax\(410px,1\.04fr\)/);
  assert.equal(css.includes('overflow:auto'),false);
});
