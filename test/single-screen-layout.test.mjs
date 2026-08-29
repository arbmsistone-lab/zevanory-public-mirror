import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
test('single-screen architecture keeps five operational domains visible',()=>{
  for(const name of ['Ação agora','Prontidão comercial &amp; economia','Motor &amp; IA','Infra &amp; release','Garantias &amp; segurança']) assert.ok(html.includes(name));
  assert.equal((html.match(/class="domain-card/g)||[]).length,5);
});
test('desktop viewport is structurally scroll-free',()=>{
  assert.ok(css.includes('overflow:hidden'));
  assert.ok(css.includes('height:100dvh'));
  assert.ok(css.includes('grid-template-columns:repeat(5,minmax(0,1fr))'));
  assert.equal(css.includes('.control-grid{grid-template-columns:1fr}'),false);
});
