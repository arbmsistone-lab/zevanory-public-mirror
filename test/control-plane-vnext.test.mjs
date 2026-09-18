import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/control-plane-vnext.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/control-plane-vnext.js', import.meta.url), 'utf8');

test('vNext assets are wired without inline executable code', () => {
  assert.match(html, /control-plane-vnext\.css/);
  assert.match(html, /control-plane-vnext\.js/);
  const executableInline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([,attrs,body]) => !/src=|application\/ld\+json/i.test(attrs) && body.trim());
  assert.equal(executableInline.length, 0);
});

test('executive surface exposes exactly six primary domains', () => {
  for (const label of ['Produtos','Operação','Receita','IA & Automação','Infraestrutura','Risco & Compliance']) assert.match(js, new RegExp(label.replace('&','&')));
  assert.match(css, /grid-template-columns:repeat\(3/);
});

test('evidence bar binds release facts instead of fabricated constants', () => {
  for (const id of ['commit','release-id','db-state','schema-migrations','domain-state','last-event']) assert.match(js, new RegExp(id));
  assert.doesNotMatch(js, /8 PROVADOS|1 PARCIAL|1 BLOQUEADO/);
  assert.match(js, /SEM RESULTADO CONSOLIDADO/);
});

test('commercial state remains fail-closed in the executive projection', () => {
  assert.match(js, /COMERCIAL BLOQUEADO/);
  assert.match(js, /validação obrigatória pendente/);
  assert.match(js, /BLOQ\|OFF\|NO-GO/);
});
