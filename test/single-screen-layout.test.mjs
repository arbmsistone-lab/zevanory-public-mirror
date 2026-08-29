import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');

test('premium single-screen architecture keeps executive domains visible',()=>{
  for(const name of ['Command Center','Resumo executivo','Motor &amp; IA','Infra &amp; release','Garantias &amp; segurança']) assert.ok(html.includes(name));
  for(const klass of ['decision-center','executive-center','operations-rail','commercial-bar']) assert.ok(html.includes(`class="${klass}`));
});

test('desktop viewport is structurally scroll-free',()=>{
  assert.ok(css.includes('overflow:hidden'));
  assert.ok(css.includes('height:100dvh'));
  assert.ok(css.includes('grid-template-columns:minmax(0,1.02fr) minmax(0,1.18fr) minmax(325px,.88fr)'));
  assert.equal(css.includes('overflow:auto'),false);
});